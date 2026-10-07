/// <reference lib="webworker" />

import * as THREE from "three";
import {
  IDM_DEFAULTS,
  MOBIL_DEFAULTS,
  NO_LEADER_GAP,
  clamp,
  climbSensitivityFromWeightToPower,
  gradeAccelFtps2,
  idmAccel,
  mobilEvaluate,
  type MobilInputs,
} from "./idm";
import { distanceToT, fastTangentAt, laneCenterPointAt } from "./laneGeometry";
import { computeEdgeTrafficStats, type EdgeTrafficStats } from "./los";
import { allows, buildSignalPlan, infoFromEdge, startOfCycle, type ApproachInfo, type SignalPlan } from "./signals";
import { assembleNetwork, computeRoute, effectiveSpeedLimitMph, hasGantry, patchEdge } from "./network";
import {
  MAX_VEHICLES,
  SIM_DT,
  VEHICLE_KIND_CODE,
  VEHICLE_HEIGHT_FT,
  VEHICLE_LENGTH_FT,
  ftpsToMph,
  mphToFtps,
  type ContractStatus,
  type Edge3D,
  type EdgeSpeedRatio,
  type RoadNetwork,
  type SignalControl,
  type CrashStats,
  type EmergencyStats,
  type IncidentView,
  type TickStats,
  type TransitLine,
  type TransitStats,
  type DriveView,
  type DriveResult,
  type LoggedAction,
  type VehicleKind,
  type VehicleState,
  type Weather,
  type WorkerInMessage,
  type WorkerOutMessage,
} from "./types";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — deterministic given the same network + seed.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng: () => number = Math.random;

// ---------------------------------------------------------------------------
// Network state (rebuilt whenever the editor sends an updated snapshot)
// ---------------------------------------------------------------------------

let network: RoadNetwork | null = null;

/** Per-edge, per-lane arrays of vehicle IDs, sorted ascending by distanceAlongEdge. Rebuilt (structure) on network change, values reset every tick. */
const laneOccupancy = new Map<string, number[][]>();
/** Count of distinct edges terminating at each node — used to skip yield logic at trivial pass-through points. */
const incomingEdgeCountByNode = new Map<string, number>();

interface SignalPhaseState {
  /** Which phase of the plan the light is in, whether it is in the all-red after that phase, and seconds into that stretch. */
  index: number;
  clearing: boolean;
  timer: number;
  plan: SignalPlan;
  /** The control the plan was built from: a new object means the player changed the light, so the plan is rebuilt. */
  control: SignalControl;
}
const signalPhaseState = new Map<string, SignalPhaseState>();

interface ApproachEntry {
  edgeId: string;
  priority: number;
  distanceToNode: number;
  speed: number;
  /** Where this vehicle goes at the junction. */
  turn: "left" | "straight" | "right";
}
/** Vehicles currently within decision range of each node's stop line. Rebuilt every tick. */
const nodeApproaches = new Map<string, ApproachEntry[]>();

const demandByEntry = new Map<string, number>();
const nextSpawnTimeByEntry = new Map<string, number>();

interface ContractSample {
  time: number;
  speed: number;
}
const contractSamples = new Map<string, ContractSample[]>();

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

let running = false;
let speedMultiplier = 1;
let simTime = 0;
/** When true, vehicle body colors are overridden by their live speed ratio (the heatmap) instead of their fixed paint color. */
let heatmapColorMode = false;
let nextVehicleId = 1;
let spawnedTotal = 0;
/** Soft cap on concurrent vehicles (<= MAX_VEHICLES, which sizes the buffers); lowered by the main thread in low-quality mode. */
let maxVehicles = MAX_VEHICLES;
let completedTripsTotal = 0;
let peopleMovedTotal = 0;
/** Service quality: how much longer drivers' trips took than an empty road would have, and the longest line of stopped cars. */
let tripDelayTotalS = 0;
let tripFreeFlowTotalS = 0;
let tripsTimed = 0;
let queueNowFt = 0;
let queuePeakFt = 0;
/** Car-seconds spent in toll express lanes this run; the main thread turns it into money. */
let expressVehicleS = 0;
/** Switches the player can turn on (free play, and levels built around them). Off leaves a run exactly as it was before they existed. */
let elasticDemand = false;
let crashRisk = false;
let pedWaits = false;
/** Roads closed right now (a bridge out): see ScriptedEvent roadClosure. */
const blockedEdges = new Set<string>();
/** Share of new vehicles that are buses / bikes. Zero keeps the classic mix (and its exact random sequence). */
let busShare = 0;
let bikeShare = 0;
let accumulator = 0;
let lastWallTimeMs = 0;

/** Multiplies every entry's spawn rate while a scripted surge is on. */
let demandScale = 1;

/** Whether left turns at signals give way to oncoming traffic. Off for the classic levels; the player sets it per level. */
let leftTurnsYield = false;
/** How close (seconds) an oncoming vehicle must be for a left-turner to wait, and how long before the green ends the wait is dropped (the last car or two always get through). */
const LEFT_GAP_S = 9;
const LEFT_SNEAK_S = 1.5;
const LEFT_QUEUE_FT = 140;
const DISPLACED_LEFT_ZONE_FT = 320;
/** Left turns made at a junction and the time they spent waiting for a gap, since the run began (counted when the turn is made). */
let leftTurnsServed = 0;
let leftTurnWaitTotalS = 0;
/** Counts one step per tick toward a vehicle's wait, however many times the stop line is looked at in that tick. */
let stepCounter = 0;
function markLeftWait(v: VehicleState) {
  if (v.leftMark === stepCounter) return;
  v.leftMark = stepCounter;
  v.leftWaitS += SIM_DT;
}
const PERMISSIVE_LEFT_ZONE_FT = 130;
const PERMISSIVE_LEFT_SPEED_FTPS = mphToFtps(9);
const DISPLACED_LEFT_SPEED_FTPS = mphToFtps(28);

// ---------------------------------------------------------------------------
// Weather and the day cycle
// ---------------------------------------------------------------------------

/** The weather the player chose, and the one a scripted storm has imposed (which wins while it lasts). */
let manualWeather: Weather = "clear";
let scriptedWeather: Weather | null = null;
function currentWeather(): Weather {
  return scriptedWeather ?? manualWeather;
}
/** Drivers slow down and leave more room in bad weather. 1 in clear weather, so classic runs are untouched. */
function weatherSpeedMult(): number {
  const w = currentWeather();
  return w === "rain" ? 0.8 : w === "fog" ? 0.85 : 1;
}
function weatherHeadwayMult(): number {
  const w = currentWeather();
  return w === "rain" ? 1.3 : w === "fog" ? 1.2 : 1;
}

/** How dark it is: 0 by day, 0.5 at dusk, 1 at night. Set from the clock the player sees. */
let darkness = 0;
/** Streets with lamps are lit; the narrowest lanes (and nothing else) are not. A tunnel always is, and so is a roundabout. */
function isLitRoad(edge: Edge3D): boolean {
  return edge.roadClassId !== "lane" || edge.isRoundaboutRing || edge.elevationLevelId === "tunnel";
}

/**
 * What the conditions do to how fast drivers go on this road: the weather, and darkness (a lit road barely matters,
 * an unlit one makes people cautious). 1 by clear day.
 */
function conditionSpeedMult(edge: Edge3D): number {
  let m = weatherSpeedMult();
  if (darkness > 0) {
    m *= 1 - darkness * (isLitRoad(edge) ? 0.03 : 0.14);
    if (currentWeather() === "fog" && !isLitRoad(edge)) m *= 0.94;
  }
  return m;
}

/** Wet pavement: tyres grip less, so a driver brakes (and pulls away) more gently and needs more road to stop. */
function brakeGripMult(): number {
  return currentWeather() === "rain" ? 0.72 : 1;
}
/** The hardest a car can slow down right now (ft/s^2, negative). */
function maxBrakeFtps2(): number {
  return currentWeather() === "rain" ? -14 : -20;
}
/** Curves are taken slower on a wet road. */
function curveGripMult(): number {
  return currentWeather() === "rain" ? 0.87 : 1;
}

/** How far ahead drivers notice people crossing, in feet: far on a clear day, short in fog or the dark. */
const CROSSING_SIGHT_CLEAR_FT = 120;
function crossingSightFt(edge: Edge3D): number {
  let sight = CROSSING_SIGHT_CLEAR_FT;
  const w = currentWeather();
  if (w === "rain") sight = Math.min(sight, 100);
  if (w === "fog") sight = Math.min(sight, 70);
  if (darkness > 0) sight = Math.min(sight, isLitRoad(edge) ? 120 - 45 * darkness : 120 - 70 * darkness);
  return sight;
}

let dayCycleOn = false;
let dayStartHour = 6;
let dayLengthS = 480;
/** Hour of the simulated day (0-24), or -1 when the day cycle is off. */
function clockHour(): number {
  if (!dayCycleOn) return -1;
  return (dayStartHour + (simTime / dayLengthS) * 24) % 24;
}
/** Demand through the day: quiet nights, a morning peak near 8, a bigger one near 5:30 pm, a lull between. */
function dayDemandMultiplier(): number {
  if (!dayCycleOn) return 1;
  const h = clockHour();
  const bump = (centre: number, width: number, height: number) => {
    // Wrap around midnight so the curve is smooth across it.
    const d = Math.min(Math.abs(h - centre), 24 - Math.abs(h - centre));
    return height * Math.exp(-(d * d) / (2 * width * width));
  };
  return 0.35 + bump(8, 1.3, 1.2) + bump(17.5, 1.6, 1.45) + bump(12.5, 2.5, 0.35);
}
/** Scripted events not yet due, soonest first. A surge end is queued as its own entry when the surge starts. */
type QueuedEvent =
  | { atS: number; kind: "breakdown"; durationS: number }
  | { atS: number; kind: "surge"; multiplier: number }
  | { atS: number; kind: "surgeEnd" }
  | { atS: number; kind: "dispatchWrecker" }
  | { atS: number; kind: "ambulance" }
  | { atS: number; kind: "crash" }
  | { atS: number; kind: "stall" }
  | { atS: number; kind: "debris" }
  | { atS: number; kind: "fender" }
  | { atS: number; kind: "weatherOn"; weather: Exclude<Weather, "clear"> }
  | { atS: number; kind: "closeOn"; edgeIds: string[] }
  | { atS: number; kind: "closeOff"; edgeIds: string[] }
  | { atS: number; kind: "weatherOff" };
let eventQueue: QueuedEvent[] = [];

const vehicles = new Map<number, VehicleState>();
const vehiclePool: VehicleState[] = [];
const despawnTimestamps: number[] = [];

// ---------------------------------------------------------------------------
// Gridlock detection: a vehicle stuck at near-zero speed for GRIDLOCK_DESPAWN_S
// is forcibly removed (with a throughput penalty) rather than sitting frozen
// forever. It gets a warning window first so the player sees it coming.
// ---------------------------------------------------------------------------

const STUCK_SPEED_THRESHOLD_FTPS = 1.5; // ~1 mph
const GRIDLOCK_WARNING_S = 18;
const GRIDLOCK_DESPAWN_S = 25;
let gridlockPenaltyTotal = 0;

// ---------------------------------------------------------------------------
// Scratch objects (allocation-free hot path)
// ---------------------------------------------------------------------------

const _pos = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _right = new THREE.Vector3();
const _quat = new THREE.Quaternion();
// Scratch for easing a car from the end of one road into the lane it joins on the next.
const _tangentNext = new THREE.Vector3();
const _rightNext = new THREE.Vector3();
const _posEnd = new THREE.Vector3();
const _posNext = new THREE.Vector3();
const _tmpTangent = new THREE.Vector3();
/** Over this last stretch of a road, a car eases toward the exact spot (and heading) where it enters the next one. */
const JUNCTION_BLEND_FT = 48;
const _scale = new THREE.Vector3(1, 1, 1);
const _matrix = new THREE.Matrix4();
const _color = new THREE.Color();
const FORWARD_AXIS = new THREE.Vector3(0, 0, 1);
const _curveTangentA = new THREE.Vector3();
const _curveTangentB = new THREE.Vector3();
const _gradeTangent = new THREE.Vector3();

// Blue -> amber -> red (never green) so free-flow vs. stopped traffic reads
// correctly for red-green colorblind players, who lose the green/red contrast
// but keep blue fully distinct.
const COLOR_FREE = new THREE.Color(0x3b82f6);
const COLOR_SLOW = new THREE.Color(0xeab308);
const COLOR_STOP = new THREE.Color(0xef4444);

/** Body paint palettes, sampled once per vehicle at spawn — a wide mix for sedans, a duller fleet-like set for semis. */
const SEDAN_PALETTE = [0xf4f4f5, 0x1c1c22, 0x8a8f98, 0xb0281c, 0x2452a6, 0x2f6b3a, 0xc9a13b, 0x5b5f66];
const AMBULANCE_COLOR = 0xffffff;
const WRECKER_COLOR = 0xffb020;
const DEBRIS_COLOR = 0x6b5436;
const BUS_PALETTE = [0xf2c230, 0x2563eb, 0xdc2626];
const BIKE_PALETTE = [0xff7a00, 0x00b8a0, 0xe0457b, 0x6d5bd0];
const TRUCK_PALETTE = [0xf4f4f5, 0xc23b2e, 0x2452a6, 0x8a8f98, 0x1c1c22];
const _spawnColor = new THREE.Color();

/** Vehicles decelerating harder than this (ft/s^2) get a brightened, near-white-hot brake light instead of a dim cruising glow. */
const HARD_BRAKE_ACCEL_THRESHOLD = -4;

// ---------------------------------------------------------------------------
// Double-buffered transfer pool
// ---------------------------------------------------------------------------

interface BufferSet {
  matrices: Float32Array;
  colors: Float32Array;
  taillightColors: Float32Array;
}

function createBufferSet(): BufferSet {
  return {
    matrices: new Float32Array(MAX_VEHICLES * 16),
    colors: new Float32Array(MAX_VEHICLES * 3),
    taillightColors: new Float32Array(MAX_VEHICLES * 3),
  };
}

const bufferPool: BufferSet[] = [createBufferSet(), createBufferSet(), createBufferSet()];

function acquireBufferSet(): BufferSet {
  return bufferPool.pop() ?? createBufferSet();
}

// ---------------------------------------------------------------------------
// Vehicle object pooling
// ---------------------------------------------------------------------------

function acquireVehicle(): VehicleState {
  const v = vehiclePool.pop();
  if (v) return v;
  return {
    id: 0,
    edgeId: "",
    laneIndex: 0,
    distanceAlongEdge: 0,
    speed: 0,
    accel: 0,
    speedFactor: 1,
    maxAccel: 0,
    comfortBrake: 0,
    jamDistance: 0,
    desiredHeadway: 0,
    minGap: 0,
    length: VEHICLE_LENGTH_FT,
    routeEdgeIds: [],
    routeIndex: 0,
    laneChangeCooldown: 0,
    destinationEdgeId: "",
    spawnTime: 0,
    wrongLaneWaitS: 0,
    stuckTimeS: 0,
    frozenUntil: 0,
    isTruck: false,
    kind: "car",
    passengers: 1,
    maxSpeedFtps: Infinity,
    yieldUntil: 0,
    yieldLane: 0,
    stopServedEdge: "",
    dwellUntil: 0,
    weightToPowerLbPerHp: 25,
    bodyColorR: 1,
    bodyColorG: 1,
    bodyColorB: 1,
    shoulder: false,
    blockedS: 0,
    leftWaitS: 0,
    leftMark: -1,
    minSpeed: 1e9,
    comboLegs: 0,
    lineId: "",
    boarding: 0,
    holdS: 0,
    holdFrom: -1,
  };
}

function releaseVehicle(v: VehicleState) {
  vehiclePool.push(v);
}

// ---------------------------------------------------------------------------
// RNG helpers
// ---------------------------------------------------------------------------

function randRange(min: number, max: number): number {
  return min + rng() * (max - min);
}

function randNormalish(mean: number, spread: number): number {
  const u = (rng() + rng() + rng()) / 3;
  return mean + (u - 0.5) * 2 * spread;
}

function sampleExponentialInterarrival(vehiclesPerHour: number, entryId?: string): number {
  if (vehiclesPerHour <= 0) return simTime + 1e9;
  const elastic = elasticDemand && entryId ? (elasticMult.get(entryId) ?? 1) : 1;
  const ratePerSecond = (vehiclesPerHour * demandScale * dayDemandMultiplier() * elastic) / 3600;
  const u = Math.max(rng(), 1e-9);
  return simTime + -Math.log(1 - u) / ratePerSecond;
}

// ---------------------------------------------------------------------------
// Network (re)assembly
// ---------------------------------------------------------------------------

function onNetworkUpdated(msg: Extract<WorkerInMessage, { type: "updateNetwork" }>) {
  network = assembleNetwork(msg.network);
  rng = mulberry32(msg.seed);

  laneOccupancy.clear();
  occupiedLanes = [];
  incomingEdgeCountByNode.clear();
  for (const edge of network.edges) {
    const lanes: number[][] = [];
    for (let i = 0; i < edge.lanes; i++) lanes.push([]);
    laneOccupancy.set(edge.id, lanes);
    incomingEdgeCountByNode.set(edge.toNodeId, (incomingEdgeCountByNode.get(edge.toNodeId) ?? 0) + 1);
  }

  for (const nodeId of Array.from(signalPhaseState.keys())) {
    if (!network.nodesById.has(nodeId)) signalPhaseState.delete(nodeId);
  }

  const currentEntryIds = new Set<string>();
  for (const edge of network.edges) {
    if (edge.zone?.type === "entry") {
      currentEntryIds.add(edge.id);
      if (!demandByEntry.has(edge.id)) {
        demandByEntry.set(edge.id, edge.zone.demandVehPerHour);
        nextSpawnTimeByEntry.set(edge.id, sampleExponentialInterarrival(edge.zone.demandVehPerHour, edge.id));
      }
    }
  }
  for (const key of Array.from(demandByEntry.keys())) {
    if (!currentEntryIds.has(key)) {
      demandByEntry.delete(key);
      nextSpawnTimeByEntry.delete(key);
    }
  }

  const currentDestIds = new Set<string>();
  for (const edge of network.edges) {
    if (edge.zone?.type === "destination") {
      currentDestIds.add(edge.id);
      if (!contractSamples.has(edge.id)) contractSamples.set(edge.id, []);
    }
  }
  for (const key of Array.from(contractSamples.keys())) {
    if (!currentDestIds.has(key)) contractSamples.delete(key);
  }

  rebuildMeteredEdges();
  congestionTimer.clear();
  problemEdges.clear();
  lastSnapshotSimTime = simTime;
  gridlockPenaltyTotal = 0;
  completedTripsTotal = 0;
  peopleMovedTotal = 0;
  resetServiceStats();
  rebuildCrossings();

  for (const [id, v] of vehicles) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) {
      releaseVehicle(v);
      vehicles.delete(id);
      ambulances.delete(id);
      responders.delete(id);
    } else if (v.laneIndex >= edge.lanes) {
      // a lane was taken away (a reversed lane): move over into the last one
      v.laneIndex = edge.lanes - 1;
    }
  }
}

/** The shortest route, steering clear of roads that are closed right now. */
function routeBetween(from: string, to: string): string[] | null {
  return network ? computeRoute(network, from, to, blockedEdges.size > 0 ? blockedEdges : undefined) : null;
}

function resetServiceStats() {
  tripDelayTotalS = 0;
  tripFreeFlowTotalS = 0;
  tripsTimed = 0;
  queueNowFt = 0;
  queuePeakFt = 0;
  expressVehicleS = 0;
  resetElasticDemand();
  riskCrashes = 0;
  pedArrivals = 0;
  pedWaitTotalS = 0;
  pedGaveUp = 0;
  meterNext.clear();
}

/** Records a finished trip for the delay average: its time on the road against the time at the limit all the way. Cars and trucks only (a bus's stops are not delay). */
function recordTripDelay(v: VehicleState) {
  if (v.kind !== "car" && v.kind !== "truck") return;
  if (!network) return;
  let freeS = 0;
  for (const id of v.routeEdgeIds) {
    const e = network.edgesById.get(id);
    if (e) freeS += e.length / Math.max(1, mphToFtps(e.speedLimitMph));
  }
  const actualS = simTime - v.spawnTime;
  tripFreeFlowTotalS += freeS;
  tripDelayTotalS += Math.max(0, actualS - freeS);
  tripsTimed++;
  if (elasticDemand && v.routeEdgeIds.length > 0) noteOriginTrip(v.routeEdgeIds[0], Math.max(0, actualS - freeS), freeS);
}

// ---------------------------------------------------------------------------
// Demand that responds. Each entry's traffic is scaled by how well trips that started there have gone lately: a road
// that works draws more drivers (up to 30% more), a jammed one loses them (down to 55%), and the drivers it loses are
// partly riders for the bus lines. Updated every ten seconds from the delay of recently finished trips.
// ---------------------------------------------------------------------------

const elasticMult = new Map<string, number>();
const originStats = new Map<string, { delay: number; free: number; n: number }>();
let nextElasticUpdate = 10;
/** Share of car demand that has moved to buses, so stops fill faster the worse the roads are. */
let transitShift = 0;
const ELASTIC_MAX = 1.3;
const ELASTIC_MIN = 0.55;

function resetElasticDemand() {
  elasticMult.clear();
  originStats.clear();
  nextElasticUpdate = 10;
  transitShift = 0;
}

function noteOriginTrip(origin: string, delayS: number, freeS: number) {
  const st = originStats.get(origin) ?? { delay: 0, free: 0, n: 0 };
  st.delay += delayS;
  st.free += freeS;
  st.n++;
  originStats.set(origin, st);
}

function updateElasticDemand() {
  if (!elasticDemand || simTime < nextElasticUpdate) return;
  nextElasticUpdate = simTime + 10;
  let lost = 0;
  let n = 0;
  for (const entryId of demandByEntry.keys()) {
    const st = originStats.get(entryId);
    let m = elasticMult.get(entryId) ?? 1;
    if (st && st.n >= 3 && st.free > 0) {
      const target = clamp(ELASTIC_MAX - 0.5 * (st.delay / st.free), ELASTIC_MIN, ELASTIC_MAX);
      m += (target - m) * 0.2;
      elasticMult.set(entryId, m);
      st.delay *= 0.5;
      st.free *= 0.5;
      st.n *= 0.5;
    }
    lost += Math.max(0, 1 - m);
    n++;
  }
  transitShift = n > 0 ? lost / n : 0;
}

/** Demand now against what the entries were set to, weighted by the entries' own demand. 1 when demand is not elastic. */
function demandIndex(): number {
  if (!elasticDemand) return 1;
  let sum = 0;
  let base = 0;
  for (const [id, d] of demandByEntry) {
    sum += d * (elasticMult.get(id) ?? 1);
    base += d;
  }
  return base > 0 ? sum / base : 1;
}

const QUEUE_SPEED_FTPS = mphToFtps(3);
const QUEUE_SLOT_FT = VEHICLE_LENGTH_FT + 6;
const _queueCount = new Map<string, number>();

/** The longest line of stopped cars in any one lane right now, in feet. Run with the heavy stats, a few times a second. */
function updateQueueStats() {
  _queueCount.clear();
  let worst = 0;
  for (const v of vehicles.values()) {
    if (v.speed > QUEUE_SPEED_FTPS || v.frozenUntil > simTime || isEmergencyKind(v.kind)) continue;
    const key = `${v.edgeId}#${v.laneIndex}`;
    const n = (_queueCount.get(key) ?? 0) + 1;
    _queueCount.set(key, n);
    if (n > worst) worst = n;
  }
  queueNowFt = worst * QUEUE_SLOT_FT;
  if (queueNowFt > queuePeakFt) queuePeakFt = queueNowFt;
}

/** Returns the sim to t = 0 with no traffic, keeping the loaded network. */
function resetRun() {
  for (const v of vehicles.values()) releaseVehicle(v);
  vehicles.clear();
  simTime = 0;
  accumulator = 0;
  spawnedTotal = 0;
  completedTripsTotal = 0;
  peopleMovedTotal = 0;
  resetServiceStats();
  pedServedTotal = 0;
  pedIncidentsTotal = 0;
  crossings.clear();
  crossingByEdge.clear();
  resetEmergency();
  resetCrashes();
  leftTurnsServed = 0;
  leftTurnWaitTotalS = 0;
  comboPasses.length = 0;
  combosTotal = 0;
  nextComboAt = 0;
  nextBusAt.clear();
  resetTransitStats();
  drive = null;
  driveResult = null;
  scriptedWeather = null;
  blockedEdges.clear();
  gridlockPenaltyTotal = 0;
  demandScale = 1;
  eventQueue = [];
  despawnTimestamps.length = 0;
  demandByEntry.clear();
  nextSpawnTimeByEntry.clear();
  contractSamples.clear();
  signalPhaseState.clear();
  congestionTimer.clear();
  problemEdges.clear();
  lastSnapshotSimTime = 0;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const MIN_SPAWN_CLEARANCE_FT = 55;

function trySpawn(entryEdgeId: string) {
  if (!network) return;
  if (vehicles.size >= maxVehicles) return;

  const edge = network.edgesById.get(entryEdgeId);
  if (!edge || edge.zone?.type !== "entry") return;
  if (blockedEdges.has(entryEdgeId)) return;

  const destinations = network.edges.filter((e) => e.zone?.type === "destination" && e.id !== entryEdgeId);
  if (destinations.length === 0) return;

  // Start at a random destination but fall through to the next reachable one, so entries in a
  // partly disconnected network still spawn at their full rate.
  const startIdx = Math.floor(rng() * destinations.length);
  let destination = destinations[startIdx];
  let route: string[] | null = null;
  for (let k = 0; k < destinations.length; k++) {
    const candidate = destinations[(startIdx + k) % destinations.length];
    const r = routeBetween(entryEdgeId, candidate.id);
    if (r && r.length > 0) {
      destination = candidate;
      route = r;
      break;
    }
  }
  if (!route) return;

  const occupancy = laneOccupancy.get(edge.id);
  if (!occupancy) return;

  // Only roll for a bus or bike when the mix asks for them, so classic levels keep their exact random sequence.
  let kind: VehicleKind | null = null;
  if (busShare > 0 || bikeShare > 0) {
    const roll = rng();
    kind = roll < busShare ? "bus" : roll < busShare + bikeShare ? "bike" : null;
  }

  const laneOrder = Array.from({ length: edge.lanes }, (_, i) => i).sort(() => rng() - 0.5);
  for (const laneIndex of laneOrder) {
    if (isReservedAgainst(edge, laneIndex, kind ?? "car")) continue;
    const laneArr = occupancy[laneIndex];
    const closest = laneArr.length > 0 ? vehicles.get(laneArr[0])?.distanceAlongEdge ?? Infinity : Infinity;
    if (closest >= MIN_SPAWN_CLEARANCE_FT) {
      spawnVehicle(edge, laneIndex, route, destination.id, kind);
      return;
    }
  }
}

function spawnVehicle(edge: Edge3D, laneIndex: number, route: string[], destinationEdgeId: string, forcedKind: VehicleKind | null = null): VehicleState {
  const v = acquireVehicle();
  v.id = nextVehicleId++;
  v.edgeId = edge.id;
  v.laneIndex = laneIndex;
  v.distanceAlongEdge = 0;
  v.routeEdgeIds = route;
  v.routeIndex = 0;
  v.destinationEdgeId = destinationEdgeId;

  // 15% semi-trucks, 85% passenger sedans, each with distinct accel/braking
  // physics and a distinct weight-to-power ratio driving how badly road
  // grade hits them (see idmAccelForVehicle / gradeAccelFtps2). When the mix
  // includes them, buses and bicycles replace some of the cars.
  const isBus = forcedKind === "bus";
  const isBike = forcedKind === "bike";
  const isAmbulance = forcedKind === "ambulance";
  const isPolice = forcedKind === "police";
  const isWrecker = forcedKind === "wrecker";
  const isDebris = forcedKind === "debris";
  // Responders and debris never touch the random stream that decides who is a truck, so adding an incident to a run
  // does not reshuffle everyone else's vehicle.
  const isTruck = !isBus && !isBike && !isAmbulance && !isPolice && !isWrecker && !isDebris && rng() < 0.15;
  v.isTruck = isTruck;
  v.kind = isBus ? "bus" : isBike ? "bike" : isAmbulance ? "ambulance" : isPolice ? "police" : isWrecker ? "wrecker" : isDebris ? "debris" : isTruck ? "truck" : "car";
  const palette = isBus ? BUS_PALETTE : isBike ? BIKE_PALETTE : isAmbulance || isPolice ? [AMBULANCE_COLOR] : isWrecker ? [WRECKER_COLOR] : isDebris ? [DEBRIS_COLOR] : isTruck ? TRUCK_PALETTE : SEDAN_PALETTE;
  _spawnColor.set(palette[Math.floor(rng() * palette.length)]);
  v.bodyColorR = _spawnColor.r;
  v.bodyColorG = _spawnColor.g;
  v.bodyColorB = _spawnColor.b;
  v.weightToPowerLbPerHp = isBus ? randRange(190, 240) : isBike ? 8 : isTruck ? randRange(260, 340) : randRange(18, 32);
  v.length = isBus ? randRange(38, 42) : isBike ? 6 : isAmbulance ? 21 : isPolice ? 16 : isWrecker ? 28 : isDebris ? 5 : isTruck ? randRange(32, 42) : randRange(13, 19);
  v.maxAccel = isBus ? randRange(2.2, 2.9) : isBike ? randRange(1.2, 1.8) : isAmbulance || isPolice || isWrecker ? 6 : isTruck ? randRange(2.6, 3.6) : randRange(3.8, 5.4);
  v.comfortBrake = isBus ? randRange(4.5, 5.5) : isBike ? 3.5 : isAmbulance || isPolice || isWrecker ? 8 : isTruck ? randRange(5.5, 6.5) : randRange(5.8, 7.6);
  v.passengers = isBus ? Math.round(randRange(22, 42)) : isAmbulance || isPolice || isWrecker || isDebris ? 0 : isBike || isTruck ? 1 : 1.4;
  v.yieldUntil = 0;
  v.yieldLane = 0;
  v.stopServedEdge = "";
  v.dwellUntil = 0;
  v.maxSpeedFtps = isBike ? mphToFtps(randRange(10, 13)) : Infinity;
  v.jamDistance = isBike ? randRange(2.5, 3.5) : randRange(5.5, 7.5);
  v.desiredHeadway = isBus || isTruck ? randRange(1.6, 2.0) : isBike ? randRange(0.8, 1.1) : isAmbulance || isPolice || isWrecker ? 0.9 : randRange(1.1, 1.7);
  v.minGap = v.jamDistance;
  v.speedFactor = isAmbulance || isPolice || isWrecker ? 1.3 : isBus ? randNormalish(0.92, 0.05) : randNormalish(1.0, 0.12);
  v.speed = Math.min(Math.min(v.speedFactor, 1.0) * mphToFtps(effectiveSpeedLimitMph(edge)) * 0.85, v.maxSpeedFtps);
  v.accel = 0;
  v.laneChangeCooldown = randRange(0, 60);
  v.spawnTime = simTime;
  v.wrongLaneWaitS = 0;
  v.stuckTimeS = 0;
  v.frozenUntil = 0;
  v.shoulder = false;
  v.blockedS = 0;
  v.leftWaitS = 0;
  v.leftMark = -1;
  v.minSpeed = 1e9;
  v.comboLegs = 0;
  v.lineId = "";
  v.boarding = 0;
  v.holdS = 0;
  v.holdFrom = -1;

  vehicles.set(v.id, v);
  spawnedTotal++;
  return v;
}

function updateSpawning() {
  for (const [entryId, demand] of demandByEntry) {
    let nextTime = nextSpawnTimeByEntry.get(entryId) ?? simTime + 1e9;
    let guard = 0;
    while (simTime >= nextTime && guard < 8) {
      trySpawn(entryId);
      nextTime = sampleExponentialInterarrival(demand, entryId);
      guard++;
    }
    nextSpawnTimeByEntry.set(entryId, nextTime);
  }
}

// ---------------------------------------------------------------------------
// Lane occupancy rebuild (per tick)
// ---------------------------------------------------------------------------

/** Lane lists that held vehicles at the last rebuild: the only ones that need clearing (most of a big map is empty). */
let occupiedLanes: number[][] = [];
function rebuildLaneOccupancy() {
  for (const arr of occupiedLanes) arr.length = 0;
  occupiedLanes = [];
  for (const v of vehicles.values()) {
    const lanes = laneOccupancy.get(v.edgeId);
    if (!lanes) continue;
    const laneArr = lanes[clamp(v.laneIndex, 0, lanes.length - 1)];
    if (laneArr.length === 0) occupiedLanes.push(laneArr);
    laneArr.push(v.id);
  }
  // Lanes keep almost the same order from one tick to the next, so an insertion sort on each lane's distances (read
  // once per vehicle) beats a comparator that looks both vehicles up on every comparison. It is stable, like sort().
  for (const arr of occupiedLanes) {
    const n = arr.length;
    if (n < 2) continue;
    if (occupancyScratch.length < n) occupancyScratch = new Float64Array(n * 2);
    const d = occupancyScratch;
    for (let i = 0; i < n; i++) d[i] = vehicles.get(arr[i])!.distanceAlongEdge;
    for (let i = 1; i < n; i++) {
      const di = d[i];
      const idi = arr[i];
      let j = i - 1;
      while (j >= 0 && d[j] > di) {
        d[j + 1] = d[j];
        arr[j + 1] = arr[j];
        j--;
      }
      d[j + 1] = di;
      arr[j + 1] = idi;
    }
  }
}
let occupancyScratch = new Float64Array(256);

// ---------------------------------------------------------------------------
// Junction control: gap-acceptance priority yielding + signal phases
// ---------------------------------------------------------------------------

const JUNCTION_APPROACH_FT = 130;
const JUNCTION_COMMIT_FT = 12;

/** What the signal plan needs to know about an approach: its moves at the junction and the way it is heading. */
function approachInfo(edgeId: string): ApproachInfo | null {
  const edge = network?.edgesById.get(edgeId);
  return edge ? infoFromEdge(edge) : null;
}

function updateSignalPhases(dt: number) {
  if (!network) return;
  for (const [nodeId, node] of network.nodesById) {
    if (node.control?.type !== "signal") continue;
    const ctrl = node.control;
    let state = signalPhaseState.get(nodeId);
    if (!state || state.control !== ctrl) {
      const plan = buildSignalPlan(ctrl, approachInfo);
      if (!state) {
        state = { ...startOfCycle(plan, ctrl.offsetS ?? 0), plan, control: ctrl };
        signalPhaseState.set(nodeId, state);
      } else {
        // The player changed the light: keep where it is in its cycle unless that phase no longer exists.
        state.plan = plan;
        state.control = ctrl;
        if (state.index >= plan.phases.length) {
          state.index = 0;
          state.clearing = false;
          state.timer = 0;
        }
      }
    }
    const { plan } = state;
    if (plan.phases.length === 0) continue;
    state.timer += dt;
    const duration = state.clearing ? plan.clearS : plan.phases[state.index].durationS;
    if (state.timer >= duration) {
      state.timer = 0;
      if (state.clearing) {
        state.clearing = false;
        state.index = (state.index + 1) % plan.phases.length;
        // People cross while every approach is red.
        if (plan.phases[state.index].pedestrian) pedServedTotal += Math.round(plan.phases[state.index].durationS * PEDESTRIANS_PER_PHASE_SECOND);
      } else {
        state.clearing = true;
      }
    }
  }
}
/** What every controlled approach's light shows: red, green, a left-turn arrow on its own, or amber for the first moments of the all-red after a green. */
function signalHeadStates(): [string, number][] {
  const out: [string, number][] = [];
  for (const state of signalPhaseState.values()) {
    const { plan } = state;
    if (plan.phases.length === 0) continue;
    const phase = plan.phases[state.index];
    for (const id of plan.controlled) {
      const bits = phase.allow.get(id) ?? 0;
      if (state.clearing) out.push([id, bits !== 0 && state.timer < Math.min(2, plan.clearS) ? 3 : 0]);
      else out.push([id, bits === 0 ? 0 : bits === 1 ? 2 : 1]);
    }
  }
  return out;
}
/** How many people use a signal's pedestrian phase for each second it lasts. */
const PEDESTRIANS_PER_PHASE_SECOND = 0.5;

function rebuildNodeApproaches() {
  for (const arr of nodeApproaches.values()) arr.length = 0;
  if (!network) return;
  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;
    const distanceToNode = edge.length - v.distanceAlongEdge;
    if (distanceToNode < 0 || distanceToNode > JUNCTION_APPROACH_FT) continue;
    let arr = nodeApproaches.get(edge.toNodeId);
    if (!arr) {
      arr = [];
      nodeApproaches.set(edge.toNodeId, arr);
    }
    const nextId = v.routeEdgeIds[v.routeIndex + 1];
    arr.push({ edgeId: edge.id, priority: edge.priority, distanceToNode, speed: v.speed, turn: (nextId && edge.nextMoves.get(nextId)) || "straight" });
  }
}

const RING_ENTRY_CLEAR_FT = 38;
const RING_VEHICLE_SLOT_FT = 32;

/**
 * True if a vehicle about to enter a roundabout should hold at the line because the ring segment it would
 * join is crowded. Without this, cars "commit" into a full ring, it packs solid, and the whole roundabout
 * locks up with nobody able to exit.
 */
function ringEntryBlocked(v: VehicleState, edge: Edge3D): boolean {
  if (!network || edge.isRoundaboutRing) return false;
  const next = network.edgesById.get(v.routeEdgeIds[v.routeIndex + 1] ?? "");
  if (!next?.isRoundaboutRing) return false;
  const lanes = laneOccupancy.get(next.id);
  if (!lanes) return false;
  let count = 0;
  for (const lane of lanes) {
    for (const id of lane) {
      count++;
      const other = vehicles.get(id);
      if (other && other.distanceAlongEdge < RING_ENTRY_CLEAR_FT) return true;
    }
  }
  return count >= Math.max(1, Math.floor((next.length * next.lanes) / RING_VEHICLE_SLOT_FT));
}

// ---------------------------------------------------------------------------
// Pedestrian crossings. One per physical place (both carriageways of a two-way road share it). People arrive at
// random; while they cross, approaching traffic stops. Where people cross without a marked crossing they step
// out into traffic instead: a short, abrupt stop that counts as an incident if cars were coming.
// ---------------------------------------------------------------------------

const PED_GAP_DEMAND_S = 20;
const PED_GAP_MARKED_ONLY_S = 45;
const PED_WALK_S = 8;
const PED_DART_S = 4.5;
const CROSSING_STOP_BEFORE_FT = 12;
const CROSSING_APPROACH_FT = 120;

interface Crossing {
  key: string;
  edgeIds: string[];
  distByEdge: Map<string, number>;
  marked: boolean;
  /** People really want to cross here (set by the level); otherwise only the odd walker uses a placed crossing. */
  demand: boolean;
  nextAt: number;
  /** With ped waits on: someone has come to cross and is waiting (since `arrivedAt`) for a gap or the button. */
  waiting: boolean;
  arrivedAt: number;
  groupSize: number;
  pendingDir: 1 | -1;
  /** Most lanes of the roads here: wider roads take longer to stop. */
  lanes: number;
  walkStart: number;
  walkUntil: number;
  /** A near miss was already counted for this walk. */
  missed: boolean;
  dir: 1 | -1;
  center: [number, number, number];
  right: [number, number];
  halfWidth: number;
}

const crossings = new Map<string, Crossing>();
const crossingByEdge = new Map<string, Crossing>();
let pedServedTotal = 0;
let pedIncidentsTotal = 0;
const _upAxis = new THREE.Vector3(0, 1, 0);

function crossingGap(c: Crossing): number {
  const mean = c.demand ? PED_GAP_DEMAND_S : PED_GAP_MARKED_ONLY_S;
  return -Math.log(1 - Math.max(rng(), 1e-9)) * mean;
}

/** Rebuilds the crossing list from the network's flags, keeping the timers of crossings that still exist. */
function rebuildCrossings() {
  if (!network) return;
  const previous = new Map(crossings);
  crossings.clear();
  crossingByEdge.clear();
  for (const edge of network.edges) {
    if ((!edge.crosswalk && !edge.jaywalkers) || edge.isRoundaboutRing) continue;
    const key = edge.fromNodeId < edge.toNodeId ? `${edge.fromNodeId}|${edge.toNodeId}` : `${edge.toNodeId}|${edge.fromNodeId}`;
    let c = crossings.get(key);
    if (!c) {
      const old = previous.get(key);
      edge.spline.getPointAt(0.5, _pos);
      edge.spline.getTangentAt(0.5, _tangent);
      _right.crossVectors(_tangent, _upAxis).normalize();
      c = {
        key,
        edgeIds: [],
        distByEdge: new Map(),
        marked: false,
        demand: false,
        nextAt: old ? old.nextAt : simTime + randRange(3, PED_GAP_DEMAND_S),
        waiting: old?.waiting ?? false,
        arrivedAt: old?.arrivedAt ?? 0,
        groupSize: old?.groupSize ?? 1,
        pendingDir: old?.pendingDir ?? 1,
        lanes: 1,
        walkStart: old?.walkStart ?? -1e9,
        walkUntil: old?.walkUntil ?? -1e9,
        missed: old?.missed ?? false,
        dir: old?.dir ?? 1,
        center: [_pos.x, _pos.y, _pos.z],
        right: [_right.x, _right.z],
        halfWidth: 0,
      };
      crossings.set(key, c);
    }
    c.edgeIds.push(edge.id);
    c.distByEdge.set(edge.id, edge.length * 0.5);
    c.marked = c.marked || edge.crosswalk;
    c.demand = c.demand || edge.jaywalkers;
    c.halfWidth = Math.max(c.halfWidth, edge.lateralShiftFt + (edge.lanes * edge.laneWidthFt) / 2 + 3);
    c.lanes = Math.max(c.lanes, edge.lanes);
    crossingByEdge.set(edge.id, c);
  }
}

function trafficApproachingCrossing(c: Crossing): boolean {
  for (const v of vehicles.values()) {
    const at = c.distByEdge.get(v.edgeId);
    if (at === undefined) continue;
    const behind = at - v.distanceAlongEdge;
    if (behind > 0 && behind < CROSSING_APPROACH_FT && v.speed > 8) return true;
  }
  return false;
}

/** Where traffic at a marked crossing can no longer stop in time: a car this close to the people, still moving. */
const NEAR_MISS_ZONE_FT = 14;
const NEAR_MISS_SPEED_FTPS = 22;

/** In fog or the dark, drivers see people late: a car that is still doing speed at the crossing while people are on it counts as stepping into traffic. Skipped in clear conditions, where braking always makes it. */
function checkNearMisses(c: Crossing) {
  if (simTime >= c.walkUntil || c.missed) return;
  for (const v of vehicles.values()) {
    const at = c.distByEdge.get(v.edgeId);
    if (at === undefined || isEmergencyKind(v.kind)) continue;
    const edge = network?.edgesById.get(v.edgeId);
    if (!edge || crossingSightFt(edge) >= CROSSING_SIGHT_CLEAR_FT) return;
    const toLine = at - v.distanceAlongEdge;
    if (toLine > -NEAR_MISS_ZONE_FT && toLine < NEAR_MISS_ZONE_FT && v.speed > NEAR_MISS_SPEED_FTPS) {
      c.missed = true;
      pedIncidentsTotal++;
      return;
    }
  }
}

let pedArrivals = 0;
let pedWaitTotalS = 0;
let pedGaveUp = 0;
/** At a marked crossing the button changes the lights after this long on a busy road: a few seconds, more for each lane. */
const PED_BUTTON_BASE_S = 4;
const PED_BUTTON_PER_LANE_S = 1.5;
/** Without a crossing, someone waits this long for a gap and then steps out. */
const PED_PATIENCE_S = 14;

/** People who arrive at a crossing wait for a gap in the traffic, or for the button, and the wait is scored; those without a crossing give up and step out. */
function updateCrossingWaits(c: Crossing) {
  if (!c.waiting) {
    if (simTime < c.nextAt) return;
    c.waiting = true;
    c.arrivedAt = simTime;
    c.groupSize = 1 + Math.floor(rng() * 3);
    c.pendingDir = rng() < 0.5 ? 1 : -1;
    pedArrivals += c.groupSize;
  }
  const waited = simTime - c.arrivedAt;
  const traffic = trafficApproachingCrossing(c);
  let go = !traffic;
  if (!go) go = c.marked ? waited >= PED_BUTTON_BASE_S + PED_BUTTON_PER_LANE_S * c.lanes : waited >= PED_PATIENCE_S;
  if (!go) return;
  c.waiting = false;
  pedWaitTotalS += waited * c.groupSize;
  c.walkStart = simTime;
  c.dir = c.pendingDir;
  pedServedTotal += c.groupSize;
  if (c.marked) {
    c.walkUntil = simTime + PED_WALK_S;
  } else {
    c.walkUntil = simTime + PED_DART_S;
    if (traffic) {
      pedIncidentsTotal++;
      pedGaveUp += c.groupSize;
    }
  }
  c.nextAt = c.walkUntil + crossingGap(c);
}

function updateCrossings() {
  for (const c of crossings.values()) {
    if (simTime < c.walkUntil) {
      if (c.marked) checkNearMisses(c);
      continue;
    }
    if (pedWaits) {
      updateCrossingWaits(c);
      continue;
    }
    if (simTime < c.nextAt) continue;
    c.missed = false;
    c.walkStart = simTime;
    c.dir = rng() < 0.5 ? 1 : -1;
    pedServedTotal += 1 + Math.floor(rng() * 3);
    if (c.marked) {
      c.walkUntil = simTime + PED_WALK_S;
    } else {
      c.walkUntil = simTime + PED_DART_S;
      if (trafficApproachingCrossing(c)) pedIncidentsTotal++;
    }
    c.nextAt = c.walkUntil + crossingGap(c);
  }
}

/** Stop line for traffic while people are crossing this road. Emergency vehicles don't stop. */
function crossingStopDistance(v: VehicleState, edge: Edge3D): number | null {
  const c = crossingByEdge.get(edge.id);
  if (!c || simTime >= c.walkUntil || isEmergencyKind(v.kind)) return null;
  const d = (c.distByEdge.get(edge.id) ?? 0) - CROSSING_STOP_BEFORE_FT - v.distanceAlongEdge;
  return d > 0.5 && d <= crossingSightFt(edge) ? d : null;
}

/** Crossings with people on the road right now, for the renderer: [x, y, z, rightX, rightZ, halfWidth, progress 0-1, direction, marked 1/0]. */
function activeCrossingViews(): number[][] {
  const out: number[][] = [];
  for (const c of crossings.values()) {
    if (simTime >= c.walkUntil || simTime < c.walkStart) continue;
    const progress = (simTime - c.walkStart) / (c.walkUntil - c.walkStart);
    out.push([c.center[0], c.center[1], c.center[2], c.right[0], c.right[1], c.halfWidth, progress, c.dir, c.marked ? 1 : 0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emergency vehicles
// ---------------------------------------------------------------------------

const AMBULANCE_YIELD_AHEAD_FT = 220;
/** Seconds a dispatch may wait for a free spot at an entry before it is dropped. */
const AMBULANCE_WAIT_LIMIT_S = 25;
const AMBULANCE_FREE_FLOW_FACTOR = 1.3;

interface AmbulanceTrack {
  spawnT: number;
  idealS: number;
}
const ambulances = new Map<number, AmbulanceTrack>();
let ambDispatched = 0;
let ambCompleted = 0;
let ambTotalResponseS = 0;
let ambTotalIdealS = 0;
let ambLastResponseS = 0;
let ambLastIdealS = 0;
/** Dispatches that have not found room on the road yet: the sim time each one was requested. */
let ambPending: number[] = [];

function resetEmergency() {
  ambulances.clear();
  ambDispatched = 0;
  ambCompleted = 0;
  ambTotalResponseS = 0;
  ambTotalIdealS = 0;
  ambLastResponseS = 0;
  ambLastIdealS = 0;
  ambPending = [];
}

function emergencyStats(): EmergencyStats {
  return {
    dispatched: ambDispatched,
    completed: ambCompleted,
    waiting: ambPending.length,
    active: ambulances.size,
    totalResponseS: ambTotalResponseS,
    totalIdealS: ambTotalIdealS,
    lastResponseS: ambLastResponseS,
    lastIdealS: ambLastIdealS,
  };
}

/** Puts one waiting ambulance on the road at a random entry that has room and a route to somewhere. Returns false if nothing fit yet. */
function trySpawnAmbulance(): boolean {
  if (!network) return false;
  const entries = network.edges.filter((e) => e.zone?.type === "entry");
  const destinations = network.edges.filter((e) => e.zone?.type === "destination");
  if (entries.length === 0 || destinations.length === 0) return false;
  const start = Math.floor(rng() * entries.length);
  for (let k = 0; k < entries.length; k++) {
    const edge = entries[(start + k) % entries.length];
    const occupancy = laneOccupancy.get(edge.id);
    if (!occupancy) continue;
    const dStart = Math.floor(rng() * destinations.length);
    let route: string[] | null = null;
    let destId = "";
    for (let j = 0; j < destinations.length && !route; j++) {
      const cand = destinations[(dStart + j) % destinations.length];
      if (cand.id === edge.id) continue;
      const r = routeBetween(edge.id, cand.id);
      if (r && r.length > 0) {
        route = r;
        destId = cand.id;
      }
    }
    if (!route) continue;
    for (let lane = 0; lane < edge.lanes; lane++) {
      const first = occupancy[lane].length > 0 ? vehicles.get(occupancy[lane][0])?.distanceAlongEdge ?? Infinity : Infinity;
      if (first < MIN_SPAWN_CLEARANCE_FT) continue;
      spawnVehicle(edge, lane, route, destId, "ambulance");
      const id = nextVehicleId - 1;
      let idealS = 0;
      for (const eid of route) {
        const e = network.edgesById.get(eid);
        if (e) idealS += e.length / (mphToFtps(e.speedLimitMph) * AMBULANCE_FREE_FLOW_FACTOR);
      }
      ambulances.set(id, { spawnT: simTime, idealS });
      ambDispatched++;
      return true;
    }
  }
  return false;
}

function updateAmbulanceDispatch() {
  if (ambPending.length === 0) return;
  if (trySpawnAmbulance()) {
    ambPending.shift();
    return;
  }
  // Nowhere to put it for too long: drop the request rather than hold the level hostage.
  while (ambPending.length > 0 && simTime - ambPending[0] > AMBULANCE_WAIT_LIMIT_S) ambPending.shift();
}

/** Marks the vehicles in an ambulance's way so they pull out of its lane. */
function markAmbulanceYielders() {
  if (ambulances.size === 0 && responders.size === 0) return;
  for (const id of [...ambulances.keys(), ...responders]) {
    const amb = vehicles.get(id);
    if (!amb) continue;
    const lanes = laneOccupancy.get(amb.edgeId);
    const edge = network?.edgesById.get(amb.edgeId);
    if (!lanes || !edge) continue;
    const laneArr = lanes[clamp(amb.laneIndex, 0, lanes.length - 1)];
    for (const otherId of laneArr) {
      const other = vehicles.get(otherId);
      if (!other || other.id === amb.id) continue;
      const ahead = other.distanceAlongEdge - amb.distanceAlongEdge;
      if (ahead > 0 && ahead < AMBULANCE_YIELD_AHEAD_FT) {
        other.yieldUntil = simTime + 2.5;
        other.yieldLane = amb.laneIndex;
      }
    }
  }
}

function recordAmbulanceArrival(v: VehicleState) {
  const track = ambulances.get(v.id);
  if (!track) return;
  ambulances.delete(v.id);
  ambCompleted++;
  ambLastResponseS = simTime - track.spawnT;
  ambLastIdealS = track.idealS;
  ambTotalResponseS += ambLastResponseS;
  ambTotalIdealS += ambLastIdealS;
}

// ---------------------------------------------------------------------------
// Bus stops: a bus on a route through a stop pulls up at it, waits while people board, and carries more riders
// for it. A bus stopped in a general lane holds up the cars behind it, which is the price of a stop.
// ---------------------------------------------------------------------------

const BUS_STOP_AT = 0.6;
/** Boarding takes a few seconds to open the doors plus a moment per rider. */
const BUS_DWELL_BASE_S = 3.5;
const BUS_DWELL_PER_RIDER_S = 0.6;
const BUS_DWELL_MAX_S = 24;
const BUS_STOP_APPROACH_FT = 110;
const BUS_MAX_RIDERS = 70;
/** People arrive at a stop at this rate (per second) and wait for the next bus, up to a crowd of this size. A stop two lines share draws more riders: they change here. */
const STOP_ARRIVAL_PER_S = 0.2;
const STOP_CROWD_MAX = 45;
const TRANSFER_STOP_DEMAND = 1.6;
/** A holding bus waits at most this long. */
const BUS_HOLD_MAX_S = 25;
/** A bus on a holding line keeps at least this share of the timetable's headway behind the one ahead. */
const BUS_HOLD_HEADWAY_SHARE = 0.85;

interface StopState {
  /** When a bus last finished boarding here (the crowd builds from then). */
  lastServedAt: number;
  /** When the previous bus of each line began boarding here (for headways and holding). */
  lastBusAt: Map<string, number>;
}
const stopState = new Map<string, StopState>();
/** How many of the player's bus lines run along each road: a stop on a road with two or more is a transfer stop. */
let linesOnEdge = new Map<string, number>();
let busServices = 0;
let busHeadwaySum = 0;
let busHeadwaySq = 0;
let busHeadwayN = 0;
let busHoldTotalS = 0;
let busBoardedTotal = 0;
let transferRidersTotal = 0;

function resetTransitStats() {
  stopState.clear();
  busServices = 0;
  busHeadwaySum = 0;
  busHeadwaySq = 0;
  busHeadwayN = 0;
  busHoldTotalS = 0;
  busBoardedTotal = 0;
  transferRidersTotal = 0;
}

function transitStats(): TransitStats {
  const mean = busHeadwayN > 0 ? busHeadwaySum / busHeadwayN : 0;
  const variance = busHeadwayN > 1 ? Math.max(0, busHeadwaySq / busHeadwayN - mean * mean) : 0;
  return {
    services: busServices,
    headwayMeanS: mean,
    headwayCv: mean > 0 ? Math.sqrt(variance) / mean : 0,
    boarded: busBoardedTotal,
    transfers: transferRidersTotal,
    heldS: busHoldTotalS,
  };
}

function rebuildLinesOnEdge() {
  linesOnEdge = new Map();
  for (const line of transitLines) for (const id of new Set(line.edgeIds)) linesOnEdge.set(id, (linesOnEdge.get(id) ?? 0) + 1);
}

function stopCrowd(edgeId: string): number {
  const st = stopState.get(edgeId);
  const since = simTime - (st?.lastServedAt ?? 0);
  const demand = ((linesOnEdge.get(edgeId) ?? 0) >= 2 ? TRANSFER_STOP_DEMAND : 1) * (1 + transitShift * 1.5);
  return Math.min(STOP_CROWD_MAX, STOP_ARRIVAL_PER_S * demand * Math.max(0, since));
}

/** Drivers cruising a street with parking along it slow down looking for a space and watching for opening doors. */
function parkingSpeedMult(edge: Edge3D, v: VehicleState): number {
  return edge.parking && !isEmergencyKind(v.kind) ? 0.85 : 1;
}

/** Stop line for a bus that has a stop of its own ahead on this road, or null. */
function busStopDistance(v: VehicleState, edge: Edge3D): number | null {
  if (v.kind !== "bus" || !edge.busStop || v.stopServedEdge === edge.id) return null;
  const d = edge.length * BUS_STOP_AT - v.distanceAlongEdge;
  return d > -2 && d <= BUS_STOP_APPROACH_FT ? Math.max(d, 0.1) : null;
}

/**
 * Runs a bus's boarding once it has stopped at its stop. The people who have gathered since the last bus board (so a
 * bus that comes late finds a crowd and stays longer, and the bus behind it, finding few, catches up: that is how
 * buses end up bunched). A line set to hold makes a bus wait until it is a fair headway behind the one ahead.
 */
function updateBusDwell(v: VehicleState, edge: Edge3D) {
  if (v.kind !== "bus" || !edge.busStop || v.stopServedEdge === edge.id) return;
  const d = edge.length * BUS_STOP_AT - v.distanceAlongEdge;
  if (d < -2) {
    v.stopServedEdge = edge.id; // overshot (it joined the road past the stop): don't hold it up for one it can't use
    v.dwellUntil = 0;
    return;
  }
  if (v.dwellUntil === 0) {
    if (d < 16 && v.speed < 1.5) {
      const crowd = stopCrowd(edge.id);
      const boarding = Math.min(Math.round(crowd), Math.max(0, BUS_MAX_RIDERS - Math.round(v.passengers)));
      v.dwellUntil = simTime + Math.min(BUS_DWELL_MAX_S, BUS_DWELL_BASE_S + BUS_DWELL_PER_RIDER_S * boarding);
      v.boarding = boarding;
      v.holdS = 0;
      let st = stopState.get(edge.id);
      if (!st) {
        st = { lastServedAt: 0, lastBusAt: new Map() };
        stopState.set(edge.id, st);
      }
      if (v.lineId) {
        busServices++;
        const previous = st.lastBusAt.get(v.lineId) ?? -1;
        if (previous >= 0) {
          const h = simTime - previous;
          busHeadwaySum += h;
          busHeadwaySq += h * h;
          busHeadwayN++;
        }
        v.holdFrom = previous;
        st.lastBusAt.set(v.lineId, simTime);
      }
    }
    return;
  }
  if (simTime >= v.dwellUntil) {
    const line = v.lineId ? transitLines.find((l) => l.id === v.lineId) : undefined;
    if (line?.hold && v.holdFrom >= 0 && v.holdS < BUS_HOLD_MAX_S && simTime - v.holdFrom < line.headwayS * BUS_HOLD_HEADWAY_SHARE) {
      // too close behind the bus ahead: wait a second more, with the doors open (more riders can board)
      v.dwellUntil = simTime + 1;
      v.holdS += 1;
      busHoldTotalS += 1;
      return;
    }
    const st = stopState.get(edge.id);
    if (st) st.lastServedAt = simTime;
    v.stopServedEdge = edge.id;
    v.dwellUntil = 0;
    v.passengers = Math.min(BUS_MAX_RIDERS, Math.round(v.passengers) + v.boarding);
    busBoardedTotal += v.boarding;
    if ((linesOnEdge.get(edge.id) ?? 0) >= 2) transferRidersTotal += Math.round(v.boarding * 0.4);
    v.boarding = 0;
  }
}

// ---------------------------------------------------------------------------
// Transit lines: buses on a timetable along a route the player drew. They carry far more people than a car, stop at
// the stops on their way, and count toward "people moved" when they reach the end of the line.
// ---------------------------------------------------------------------------

let transitLines: TransitLine[] = [];
const nextBusAt = new Map<string, number>();
const TRANSIT_RETRY_S = 2;

function updateTransit() {
  if (!network || transitLines.length === 0) return;
  for (const line of transitLines) {
    if (line.edgeIds.length === 0) continue;
    let due = nextBusAt.get(line.id);
    if (due === undefined) {
      due = simTime + 3;
      nextBusAt.set(line.id, due);
    }
    if (simTime < due) continue;
    // Skip a line whose roads were since changed or deleted.
    const first = network.edgesById.get(line.edgeIds[0]);
    if (!first || line.edgeIds.some((id) => !network!.edgesById.has(id)) || vehicles.size >= maxVehicles) {
      nextBusAt.set(line.id, simTime + TRANSIT_RETRY_S * 3);
      continue;
    }
    const occupancy = laneOccupancy.get(first.id);
    let spawned = false;
    if (occupancy) {
      // buses prefer the right-hand lane (a reserved bus lane, if there is one)
      for (let lane = first.lanes - 1; lane >= 0 && !spawned; lane--) {
        const head = occupancy[lane].length > 0 ? vehicles.get(occupancy[lane][0])?.distanceAlongEdge ?? Infinity : Infinity;
        if (head < MIN_SPAWN_CLEARANCE_FT) continue;
        if (isReservedAgainst(first, lane, "bus")) continue;
        spawnVehicle(first, lane, line.edgeIds, line.edgeIds[line.edgeIds.length - 1], "bus").lineId = line.id;
        spawned = true;
      }
    }
    nextBusAt.set(line.id, simTime + (spawned ? line.headwayS : TRANSIT_RETRY_S));
  }
}

// ---------------------------------------------------------------------------
// Crashes. Two cars collide on an open stretch and stay where they are, blocking their lane, until a police car has
// actually driven there and spent a little time on scene. A jam between the entry and the crash therefore makes the
// crash last longer, which makes the jam worse: the same lesson as a real incident.
// ---------------------------------------------------------------------------

const CRASH_REPORT_DELAY_S = 6;
const CRASH_ON_SCENE_S = 9;
const CRASH_SCENE_RADIUS_FT = 90;
const CRASH_FOREVER = 1e12;
const RESPONDER_RETRY_S = 5;

type IncidentKind = "crash" | "stall" | "debris";

interface Incident {
  id: number;
  kind: IncidentKind;
  edgeId: string;
  distanceAlongEdge: number;
  vehicleIds: number[];
  startedAt: number;
  /** Sim time at which the police car is sent (after the crash is reported). Crashes only. */
  dispatchAt: number;
  responderId: number | null;
  /** The player asked for a wrecker, and the one that was sent (if it has set out). */
  wreckerRequested: boolean;
  wreckerId: number | null;
  wreckerRetryAt: number;
  /** Set once a responder has reached the scene: when the road is cleared. */
  clearAt: number;
  /** Stalls and debris clear themselves after this long if nobody comes (a patrol finds them eventually). */
  autoClearAt: number;
}
const incidents: Incident[] = [];
const responders = new Set<number>();
let crashSeq = 1;
let crashesHappened = 0;
let crashesCleared = 0;
let crashTotalClearS = 0;
let crashLastClearS = 0;
let crashPending = 0;
/** Fender benders still to happen, which must be on an elevated road. */
let fenderPending = 0;
let stallPending = 0;
let debrisPending = 0;
/** The road each queued debris spill should land on ("" = anywhere), in the same order. */
const debrisEdges: string[] = [];

const STALL_AUTO_CLEAR_S = 240;
const DEBRIS_AUTO_CLEAR_S = 300;
const WRECKER_ON_SCENE_S = 8;

function resetCrashes() {
  incidents.length = 0;
  responders.clear();
  crashesHappened = 0;
  crashesCleared = 0;
  crashTotalClearS = 0;
  crashLastClearS = 0;
  crashPending = 0;
  fenderPending = 0;
  stallPending = 0;
  debrisPending = 0;
  debrisEdges.length = 0;
}

function crashStats(): CrashStats {
  const open = incidents.reduce((n, i) => n + (i.kind === "crash" ? 1 : 0), 0);
  return { happened: crashesHappened, cleared: crashesCleared, open, totalClearS: crashTotalClearS, lastClearS: crashLastClearS };
}

/** The wrecker state of an incident, for its marker. */
function wreckerState(inc: Incident): IncidentView["wrecker"] {
  if (inc.wreckerId === null) return "none";
  return inc.clearAt > 0 ? "onscene" : "enroute";
}

const _incPos = new THREE.Vector3();
const _incTan = new THREE.Vector3();
const _incRight = new THREE.Vector3();

function incidentViews(): IncidentView[] {
  if (!network) return [];
  const out: IncidentView[] = [];
  for (const inc of incidents) {
    const edge = network.edgesById.get(inc.edgeId);
    if (!edge) continue;
    const first = inc.vehicleIds.length > 0 ? vehicles.get(inc.vehicleIds[0]) : undefined;
    const lane = first ? first.laneIndex : Math.floor(edge.lanes / 2);
    laneCenterPointAt(edge, distanceToT(edge, first ? first.distanceAlongEdge : inc.distanceAlongEdge), lane, _incTan, _incRight, _incPos);
    out.push({
      id: inc.id,
      kind: inc.kind,
      edgeId: inc.edgeId,
      position: [_incPos.x, _incPos.y, _incPos.z],
      ageS: simTime - inc.startedAt,
      wrecker: wreckerState(inc),
      elevated: edge.isElevated,
    });
  }
  return out;
}

function newIncident(kind: IncidentKind, edgeId: string, distance: number, vehicleIds: number[]): Incident {
  const inc: Incident = {
    id: crashSeq++,
    kind,
    edgeId,
    distanceAlongEdge: distance,
    vehicleIds,
    startedAt: simTime,
    dispatchAt: simTime + CRASH_REPORT_DELAY_S,
    responderId: null,
    wreckerRequested: false,
    wreckerId: null,
    wreckerRetryAt: 0,
    clearAt: 0,
    autoClearAt: kind === "stall" ? simTime + STALL_AUTO_CLEAR_S : kind === "debris" ? simTime + DEBRIS_AUTO_CLEAR_S : 0,
  };
  incidents.push(inc);
  return inc;
}

/** Picks a moving car mid-way along a longish open road, freezes it with the car behind it, and starts the clock. */
function causeCrash(elevatedOnly = false): boolean {
  if (!network) return false;
  const candidates: VehicleState[] = [];
  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge || edge.isRoundaboutRing || edge.length < 220 || v.frozenUntil > simTime || v.speed < 8 || isEmergencyKind(v.kind) || v.kind === "debris") continue;
    if (elevatedOnly && !edge.isElevated) continue;
    const f = v.distanceAlongEdge / edge.length;
    if (f > 0.3 && f < 0.7) candidates.push(v);
  }
  if (candidates.length === 0) return false;
  const first = candidates[Math.floor(rng() * candidates.length)];
  const hit: VehicleState[] = [first];
  const lane = laneOccupancy.get(first.edgeId)?.[clamp(first.laneIndex, 0, (laneOccupancy.get(first.edgeId)?.length ?? 1) - 1)] ?? [];
  // the car right behind in the same lane runs into it
  let behind: VehicleState | null = null;
  for (const id of lane) {
    const o = vehicles.get(id);
    if (o && o !== first && o.distanceAlongEdge < first.distanceAlongEdge && (!behind || o.distanceAlongEdge > behind.distanceAlongEdge)) behind = o;
  }
  if (behind && first.distanceAlongEdge - behind.distanceAlongEdge < 140) hit.push(behind);
  for (const v of hit) v.frozenUntil = CRASH_FOREVER;
  newIncident("crash", first.edgeId, first.distanceAlongEdge, hit.map((v) => v.id));
  crashesHappened++;
  return true;
}

// ---------------------------------------------------------------------------
// Crash risk. With it on, a driver can make a mistake: the chance per second grows with speeding, rain, fog, darkness on
// an unlit road and tailgating, from a very small base, so a calm daytime city sees almost none and a fast, wet, dark
// one sees several. A mistake is a rear-end crash with whoever is ahead (or a spin alone), and it blocks the lane until
// police arrive like any other crash.
// ---------------------------------------------------------------------------

/** Chance per vehicle-second of a mistake in perfectly calm conditions. */
const RISK_BASE_PER_S = 1 / 25000;
const RISK_EVERY_STEPS = 5;
let riskCrashes = 0;

function updateCrashRisk() {
  if (!crashRisk || !network || stepCounter % RISK_EVERY_STEPS !== 0) return;
  const dt = SIM_DT * RISK_EVERY_STEPS;
  const w = currentWeather();
  for (const v of vehicles.values()) {
    if (v.frozenUntil > simTime || v.speed < 20 || isEmergencyKind(v.kind) || v.kind === "debris" || v.kind === "bike" || isDriven(v)) continue;
    const edge = network.edgesById.get(v.edgeId);
    if (!edge || edge.isRoundaboutRing) continue;
    const limit = mphToFtps(effectiveSpeedLimitMph(edge));
    // Faster means harder to recover from a mistake: the chance grows with the square of the speed (1 at 35 mph).
    let f = clamp((v.speed / mphToFtps(35)) ** 2, 0.3, 4);
    const over = v.speed / limit;
    if (over > 1.05) f *= 1 + (over - 1.05) * 12;
    if (w === "rain") f *= 3;
    else if (w === "fog") f *= 2.6;
    if (darkness > 0) f *= 1 + darkness * (isLitRoad(edge) ? 0.6 : 2);
    // tailgating: the time gap to the car ahead in the same lane
    let leader: VehicleState | null = null;
    const lane = laneOccupancy.get(edge.id)?.[clamp(v.laneIndex, 0, edge.lanes - 1)];
    if (lane) {
      const i = lane.indexOf(v.id);
      if (i >= 0 && i < lane.length - 1) leader = vehicles.get(lane[i + 1]) ?? null;
    }
    if (leader) {
      const headway = (leader.distanceAlongEdge - leader.length - v.distanceAlongEdge) / Math.max(v.speed, 1);
      if (headway < 0.9) f *= 1 + (0.9 - headway) * 8;
    }
    if (rng() >= RISK_BASE_PER_S * f * dt) continue;
    const hit: VehicleState[] = [v];
    if (leader && leader.frozenUntil <= simTime && leader.distanceAlongEdge - leader.length - v.distanceAlongEdge < 60) hit.push(leader);
    for (const h of hit) {
      h.frozenUntil = CRASH_FOREVER;
      h.speed = 0;
    }
    newIncident("crash", v.edgeId, v.distanceAlongEdge, hit.map((h) => h.id));
    crashesHappened++;
    riskCrashes++;
  }
}

/** A semi dies in the middle lane of a freeway (any road, if there is no freeway with a truck on it). */
function causeStall(): boolean {
  if (!network) return false;
  const best: VehicleState[] = [];
  const fallback: VehicleState[] = [];
  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge || edge.isRoundaboutRing || edge.length < 260 || v.frozenUntil > simTime || v.speed < 8 || isEmergencyKind(v.kind) || v.kind === "debris" || v.kind === "bike") continue;
    const f = v.distanceAlongEdge / edge.length;
    if (f < 0.25 || f > 0.75) continue;
    const middle = Math.floor((edge.lanes - 1) / 2);
    if (v.isTruck && edge.isFreeway && v.laneIndex === middle) best.push(v);
    else if (v.isTruck) fallback.push(v);
    else if (edge.isFreeway) fallback.push(v);
  }
  const pool = best.length > 0 ? best : fallback;
  if (pool.length === 0) return false;
  const pick = pool[Math.floor(rng() * pool.length)];
  pick.frozenUntil = CRASH_FOREVER;
  newIncident("stall", pick.edgeId, pick.distanceAlongEdge, [pick.id]);
  return true;
}

/** Debris lands in a lane of an open road and sits there. */
function causeDebris(onEdge?: string): boolean {
  if (!network) return false;
  const named = onEdge ? network.edgesById.get(onEdge) : undefined;
  const edges = named && named.length >= 120 && !named.isRoundaboutRing ? [named] : network.edges.filter((e) => !e.isRoundaboutRing && !e.isTexasTurnaround && e.length >= 300 && vehicles.size < maxVehicles);
  if (edges.length === 0) return false;
  // Prefer roads that are carrying traffic, so the player has something to react to.
  const busy = edges.filter((e) => (laneOccupancy.get(e.id)?.reduce((n, l) => n + l.length, 0) ?? 0) >= 2);
  const pool = busy.length > 0 ? busy : edges;
  for (let attempt = 0; attempt < 12; attempt++) {
    const edge = pool[Math.floor(rng() * pool.length)];
    const lane = Math.floor(rng() * edge.lanes);
    const dist = edge.length * (0.4 + rng() * 0.2);
    const occupied = (laneOccupancy.get(edge.id)?.[lane] ?? []).some((id) => {
      const o = vehicles.get(id);
      return o && Math.abs(o.distanceAlongEdge - dist) < 50;
    });
    if (occupied) continue;
    const before = spawnedTotal;
    spawnVehicle(edge, lane, [edge.id], edge.id, "debris");
    spawnedTotal = before; // litter is not traffic
    const v = vehicles.get(nextVehicleId - 1)!;
    v.distanceAlongEdge = dist;
    v.speed = 0;
    v.frozenUntil = CRASH_FOREVER;
    newIncident("debris", edge.id, dist, [v.id]);
    return true;
  }
  return false;
}

/** Sends a responder (a police car, or a wrecker) from an entry, by a route that passes the incident and carries on to an exit. */
function trySpawnResponder(inc: Incident, kind: "police" | "wrecker"): number | null {
  if (!network) return null;
  const entries = network.edges.filter((e) => e.zone?.type === "entry");
  const destinations = network.edges.filter((e) => e.zone?.type === "destination");
  if (entries.length === 0 || destinations.length === 0) return null;
  // A wrecker is sent from the entry nearest the scene; a police car from wherever it happens to be.
  let order: Edge3D[];
  if (kind === "wrecker") {
    const lengthOf = (route: string[]) => route.reduce((n, id) => n + (network!.edgesById.get(id)?.length ?? 0), 0);
    order = entries
      .map((entry) => {
        const r = entry.id === inc.edgeId ? [entry.id] : routeBetween(entry.id, inc.edgeId);
        return { entry, d: r ? lengthOf(r) : Infinity };
      })
      .filter((x) => x.d < Infinity)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.entry);
  } else {
    const start = Math.floor(rng() * entries.length);
    order = entries.map((_, k) => entries[(start + k) % entries.length]);
  }
  for (const entry of order) {
    const occupancy = laneOccupancy.get(entry.id);
    if (!occupancy) continue;
    const toScene = entry.id === inc.edgeId ? [entry.id] : routeBetween(entry.id, inc.edgeId);
    if (!toScene) continue;
    let onward: string[] | null = null;
    let destId = "";
    for (const d of destinations) {
      if (d.id === inc.edgeId) continue;
      const r = routeBetween(inc.edgeId, d.id);
      if (r && r.length > 0) {
        onward = r;
        destId = d.id;
        break;
      }
    }
    if (!onward) continue;
    const route = [...toScene, ...onward.slice(1)];
    for (let lane = 0; lane < entry.lanes; lane++) {
      const first = occupancy[lane].length > 0 ? vehicles.get(occupancy[lane][0])?.distanceAlongEdge ?? Infinity : Infinity;
      if (first < MIN_SPAWN_CLEARANCE_FT) continue;
      spawnVehicle(entry, lane, route, destId, kind);
      const id = nextVehicleId - 1;
      responders.add(id);
      return id;
    }
  }
  return null;
}

/** Whether a responder is close enough to an incident to start work. */
function atScene(r: VehicleState, inc: Incident): boolean {
  return r.edgeId === inc.edgeId && Math.abs(r.distanceAlongEdge - inc.distanceAlongEdge) < CRASH_SCENE_RADIUS_FT;
}

function clearIncident(index: number) {
  const inc = incidents[index];
  // Towed away: the vehicles leave without counting as completed trips.
  for (const id of inc.vehicleIds) {
    const w = vehicles.get(id);
    if (w) {
      releaseVehicle(w);
      vehicles.delete(id);
    }
  }
  for (const rid of [inc.responderId, inc.wreckerId]) {
    const r = rid === null ? undefined : vehicles.get(rid);
    if (r) r.frozenUntil = 0;
  }
  if (inc.kind === "crash") {
    crashesCleared++;
    crashLastClearS = simTime - inc.startedAt;
    crashTotalClearS += crashLastClearS;
  }
  incidents.splice(index, 1);
}

function updateCrashes() {
  if (incidents.length === 0 && crashPending === 0 && fenderPending === 0 && stallPending === 0 && debrisPending === 0) return;
  while (crashPending > 0) {
    if (causeCrash()) crashPending--;
    else break;
  }
  while (fenderPending > 0) {
    if (causeCrash(true)) fenderPending--;
    else break;
  }
  while (stallPending > 0) {
    if (causeStall()) stallPending--;
    else break;
  }
  while (debrisPending > 0) {
    if (causeDebris(debrisEdges[0] || undefined)) {
      debrisPending--;
      debrisEdges.shift();
    } else break;
  }
  for (let i = incidents.length - 1; i >= 0; i--) {
    const inc = incidents[i];

    // The player's wrecker: sent on request, and again if it vanished before it got there.
    if (inc.wreckerRequested) {
      const w = inc.wreckerId === null ? undefined : vehicles.get(inc.wreckerId);
      if (inc.wreckerId !== null && !w) {
        responders.delete(inc.wreckerId);
        inc.wreckerId = null;
        inc.wreckerRetryAt = simTime + RESPONDER_RETRY_S;
        if (inc.clearAt > 0 && inc.responderId === null) inc.clearAt = 0;
      }
      if (inc.wreckerId === null && simTime >= inc.wreckerRetryAt) {
        inc.wreckerId = trySpawnResponder(inc, "wrecker");
        inc.wreckerRetryAt = simTime + RESPONDER_RETRY_S;
      }
    }

    // Police come to crashes by themselves, once the crash has been reported.
    if (inc.kind === "crash") {
      if (inc.responderId === null) {
        if (simTime >= inc.dispatchAt) {
          const id = trySpawnResponder(inc, "police");
          if (id !== null) {
            inc.responderId = id;
            inc.dispatchAt = simTime + RESPONDER_RETRY_S;
          } else inc.dispatchAt = simTime + RESPONDER_RETRY_S;
        }
      } else if (!vehicles.get(inc.responderId)) {
        responders.delete(inc.responderId);
        inc.responderId = null;
        inc.dispatchAt = simTime + RESPONDER_RETRY_S;
      }
    }

    // Work starts when anyone sent has arrived.
    if (inc.clearAt === 0) {
      const police = inc.responderId === null ? undefined : vehicles.get(inc.responderId);
      const wrecker = inc.wreckerId === null ? undefined : vehicles.get(inc.wreckerId);
      if (wrecker && atScene(wrecker, inc)) {
        inc.clearAt = simTime + WRECKER_ON_SCENE_S;
        wrecker.frozenUntil = inc.clearAt;
      } else if (police && atScene(police, inc) && inc.kind === "crash") {
        inc.clearAt = simTime + CRASH_ON_SCENE_S;
        police.frozenUntil = inc.clearAt;
      }
    }

    if (inc.clearAt > 0 && simTime >= inc.clearAt) {
      clearIncident(i);
      continue;
    }
    // A stall or debris nobody came for is eventually found by a patrol.
    if (inc.autoClearAt > 0 && inc.clearAt === 0 && simTime >= inc.autoClearAt) clearIncident(i);
  }
}

/**
 * A wrecker stuck in a queue it cannot pull out of drives up the shoulder instead, ignoring the cars in its lane,
 * until the road ahead opens up. (Without this a jam behind a stall keeps the tow truck out of reach, and the jam
 * never clears.)
 */
function updateShoulderMode(v: VehicleState, edge: Edge3D, dt: number) {
  // Only wreckers: police stuck in a jam is what the Pile-Up level is about, so they still have to fight through it.
  if (v.kind !== "wrecker") return;
  if (v.frozenUntil > simTime) {
    v.shoulder = false;
    v.blockedS = 0;
    return;
  }
  const limit = mphToFtps(effectiveSpeedLimitMph(edge));
  if (v.shoulder) {
    // back to the lane once it is moving freely again
    if (v.speed > limit * 0.75) v.blockedS = Math.max(0, v.blockedS - dt * 2);
    else v.blockedS = Math.min(v.blockedS + dt, SHOULDER_AFTER_S + 1);
    if (v.blockedS <= 0) v.shoulder = false;
    return;
  }
  if (v.speed < limit * 0.4) v.blockedS += dt;
  else if (v.speed > limit * 0.7) v.blockedS = 0;
  if (v.blockedS >= SHOULDER_AFTER_S) v.shoulder = true;
}
const SHOULDER_AFTER_S = 3;

// ---------------------------------------------------------------------------
// Ramp meters. A metered ramp lets one car go per release: the first to reach the stop line passes, and the next waits
// until the period has run out. The period is fixed, or (auto) set from how freely the freeway ahead is flowing: short
// when it is fast, long when it is packed, which is what keeps a ramp from feeding a jam.
// ---------------------------------------------------------------------------

/** A car this close to the stop line is already through. */
const METER_THROUGH_FT = 1.5;
const meterNext = new Map<string, number>();
let meteredEdges: Edge3D[] = [];

function rebuildMeteredEdges() {
  meteredEdges = network ? network.edges.filter((e) => e.meterS > 0 || e.meterAuto) : [];
}

/** Seconds between cars for this ramp's meter right now. */
function meterPeriodS(edge: Edge3D): number {
  if (!edge.meterAuto) return Math.max(1.5, edge.meterS);
  let slowest = 1;
  for (const id of edge.nextEdgeIds) {
    const next = network?.edgesById.get(id);
    if (!next || !next.isFreeway) continue;
    let n = 0;
    let sum = 0;
    for (const lane of laneOccupancy.get(id) ?? []) {
      for (const vid of lane) {
        const o = vehicles.get(vid);
        if (o) {
          sum += o.speed;
          n++;
        }
      }
    }
    if (n >= 3) slowest = Math.min(slowest, sum / n / Math.max(1, mphToFtps(effectiveSpeedLimitMph(next))));
  }
  if (slowest > 0.8) return 2.5;
  if (slowest > 0.5) return 2.5 + ((0.8 - slowest) / 0.3) * 5.5;
  return 8;
}

/** True while the meter on this ramp is red (a car went through less than a period ago). */
function meterRed(edge: Edge3D): boolean {
  return (edge.meterS > 0 || edge.meterAuto) && simTime < (meterNext.get(edge.id) ?? 0);
}

/** What each meter shows: [edge, 0 red | 1 green]. */
function meterStates(): [string, number][] {
  return meteredEdges.map((e) => [e.id, meterRed(e) ? 0 : 1] as [string, number]);
}

// ---------------------------------------------------------------------------
// Traffic rage and flow combos: how the drivers feel about the traffic. Rage shows who has been stopped for a while
// (and, when `rageWeaves` is on, lets the angriest of them weave between lanes through gaps they would not normally
// take); combos reward a platoon that sails through signals in a row.
// ---------------------------------------------------------------------------

/** Stopped this long (s) and a driver is visibly fuming. */
const RAGE_AFTER_S = 5;
/** Stopped this long and a driver starts weaving. */
const RAGE_WEAVE_S = 8;
const MAX_RAGE_MARKERS = 12;
const RAGE_MARKER_SPACING_FT = 70;
/** Whether the angriest drivers take desperate lane changes. Off in the levels, whose baselines were measured without it. */
let rageWeaves = false;
let rageMarkers: [number, number, number][] = [];
let rageCount = 0;

/** A flowing platoon: cars clearing signals without slowing below this speed (or half the limit on slower roads). */
const COMBO_MIN_MPH = 35;
const COMBO_PLATOON = 10;
const COMBO_WINDOW_S = 15;
const COMBO_COOLDOWN_S = 20;
const comboPasses: { t: number; node: string }[] = [];
let combosTotal = 0;
let nextComboAt = 0;

/** A driver (not an ambulance) in a jam who has had enough: no politeness, small gaps are fine. */
const RAGE_MOBIL = { ...MOBIL_DEFAULTS, politeness: 0, changeThreshold: 0.02, bSafe: 22 };

function noteSignalPass(v: VehicleState, edge: Edge3D) {
  if (v.kind !== "car" && v.kind !== "truck") return;
  const need = Math.min(mphToFtps(COMBO_MIN_MPH), mphToFtps(effectiveSpeedLimitMph(edge)) * 0.5);
  v.comboLegs = v.minSpeed >= need ? v.comboLegs + 1 : 0;
  v.minSpeed = v.speed;
  // A car that has cleared this signal without braking hard since the last one is part of a flowing platoon.
  if (v.comboLegs >= 1) comboPasses.push({ t: simTime, node: edge.toNodeId });
}

function updateFlowCombos() {
  while (comboPasses.length > 0 && comboPasses[0].t < simTime - COMBO_WINDOW_S) comboPasses.shift();
  // Ten cars, through at least two different signals, all inside the window.
  if (comboPasses.length >= COMBO_PLATOON && simTime >= nextComboAt && new Set(comboPasses.map((p) => p.node)).size >= 2) {
    combosTotal++;
    nextComboAt = simTime + COMBO_COOLDOWN_S;
    comboPasses.length = 0;
  }
}

/** Returns the distance (ft) at which a vehicle must stop for a bus stop, a crossing or a junction it cannot yet enter, or null if clear. */
function computeVirtualStopDistance(v: VehicleState, edge: Edge3D): number | null {
  let best = junctionStopDistance(v, edge);
  for (const extra of [crossingStopDistance(v, edge), busStopDistance(v, edge)]) {
    if (extra !== null && (best === null || extra < best)) best = extra;
  }
  return best;
}

/** Returns the distance (ft) at which a vehicle must stop for a junction it cannot yet enter, or null if clear. */
function junctionStopDistance(v: VehicleState, edge: Edge3D): number | null {
  if (!network || isEmergencyKind(v.kind)) return null;
  if (ringEntryBlocked(v, edge)) {
    const toLine = edge.length - v.distanceAlongEdge;
    if (toLine <= JUNCTION_APPROACH_FT) return Math.max(toLine, 0.1);
  }
  if ((edge.meterS > 0 || edge.meterAuto) && meterRed(edge)) {
    const toLine = edge.length - v.distanceAlongEdge;
    if (toLine <= JUNCTION_APPROACH_FT && toLine > METER_THROUGH_FT) return Math.max(toLine - 1, 0.1);
  }
  const nodeId = edge.toNodeId;
  const incomingCount = incomingEdgeCountByNode.get(nodeId) ?? 0;
  if (incomingCount <= 1) return null;

  const distanceToNode = edge.length - v.distanceAlongEdge;
  if (distanceToNode > JUNCTION_APPROACH_FT || distanceToNode < JUNCTION_COMMIT_FT) return null;

  const node = network.nodesById.get(nodeId);
  const control = node?.control;

  if (control?.type === "signal") {
    const phaseState = signalPhaseState.get(nodeId);
    if (!phaseState || phaseState.plan.phases.length === 0) return null;
    if (!phaseState.plan.controlled.has(edge.id)) return null;
    if (phaseState.clearing) return distanceToNode;
    const nextId = v.routeEdgeIds[v.routeIndex + 1];
    const move = (nextId && edge.nextMoves.get(nextId)) || "straight";
    if (!allows(phaseState.plan, phaseState.index, edge.id, move)) return distanceToNode;
    if (leftTurnsYield && phaseState.plan.phases[phaseState.index].permissive && mustYieldLeft(v, edge, node!.id, control, phaseState, distanceToNode)) return distanceToNode;
    return null;
  }

  const approaches = nodeApproaches.get(nodeId);
  if (!approaches || approaches.length <= 1) return null;

  for (const other of approaches) {
    if (other.edgeId === edge.id) continue;
    if (other.priority > edge.priority) return distanceToNode;
    if (other.priority === edge.priority && other.distanceToNode < distanceToNode) return distanceToNode;
  }
  return null;
}

/**
 * A left turn on a green light gives way to oncoming traffic that is going straight on or turning left across the
 * same junction, unless the road has a continuous-flow (displaced) left, where the turn has already crossed over.
 * The last seconds of the green are free: the car or two waiting in the middle always get through.
 */
function mustYieldLeft(v: VehicleState, edge: Edge3D, nodeId: string, control: { groupA: string[]; groupB: string[] }, phase: SignalPhaseState, distanceToNode: number): boolean {
  if (edge.displacedLeft) return false;
  const nextId = v.routeEdgeIds[v.routeIndex + 1];
  if (!nextId || edge.nextMoves.get(nextId) !== "left") return false;
  if (phase.timer > phase.plan.phases[phase.index].durationS - LEFT_SNEAK_S) return false;
  const approaches = nodeApproaches.get(nodeId);
  if (!approaches) return false;
  const myGroup = control.groupA.includes(edge.id) ? control.groupA : control.groupB;
  for (const other of approaches) {
    if (other.edgeId === edge.id || other.turn === "right" || !myGroup.includes(other.edgeId)) continue;
    const oe = network!.edgesById.get(other.edgeId);
    if (!oe || !opposes(edge, oe)) continue;
    // A car about to arrive blocks the turn, and so does a queue still crawling across the stop line.
    if (other.distanceToNode / Math.max(other.speed, 5) < LEFT_GAP_S || other.distanceToNode < LEFT_QUEUE_FT) { markLeftWait(v); return true; }
  }
  return false;
}

const _oppA = new THREE.Vector3();
const _oppB = new THREE.Vector3();
/** True when two roads arrive at a junction from opposite directions. */
function opposes(a: Edge3D, b: Edge3D): boolean {
  fastTangentAt(a, 1, _oppA);
  fastTangentAt(b, 1, _oppB);
  return _oppA.x * _oppB.x + _oppA.z * _oppB.z < -0.7;
}

/** Left-turners on a displaced-left road creep through the crossover at a modest speed. */
function displacedLeftSpeedCapFtps(v: VehicleState, edge: Edge3D): number {
  if (!edge.displacedLeft) {
    // With left turns giving way, a driver turning across the junction does it slowly, hunting for a gap and swinging through the tight corner.
    if (!leftTurnsYield || edge.length - v.distanceAlongEdge > PERMISSIVE_LEFT_ZONE_FT) return Infinity;
    const next = v.routeEdgeIds[v.routeIndex + 1];
    return next && edge.nextMoves.get(next) === "left" ? PERMISSIVE_LEFT_SPEED_FTPS : Infinity;
  }
  if (edge.length - v.distanceAlongEdge > DISPLACED_LEFT_ZONE_FT) return Infinity;
  const nextId = v.routeEdgeIds[v.routeIndex + 1];
  return nextId && edge.nextMoves.get(nextId) === "left" ? DISPLACED_LEFT_SPEED_FTPS : Infinity;
}

// ---------------------------------------------------------------------------
// Leader gap lookup (same-lane, crossing edge boundary via the vehicle's own route, and junction stop lines)
// ---------------------------------------------------------------------------

interface GapInfo {
  gap: number;
  leaderSpeed: number;
}

/** Lanes of `edge` that may take the vehicle's next route edge (index 0 = leftmost), or null if any lane may. */
function allowedLanesForNext(v: VehicleState, edge: Edge3D): boolean[] | null {
  const nextRouteEdgeId = v.routeEdgeIds[v.routeIndex + 1];
  const turn = edge.laneAllowed && nextRouteEdgeId ? (edge.laneAllowed.get(nextRouteEdgeId) ?? null) : null;
  // Closed lanes (a red X on the gantry) are off limits from a warning distance before the gantry onward.
  if (edge.closedLanes.some(Boolean) && v.distanceAlongEdge >= gantryDistance(edge) - CLOSURE_WARNING_FT && !isEmergencyKind(v.kind)) {
    const open = edge.closedLanes.map((closed) => !closed);
    if (!open.some(Boolean)) return turn; // a road can't be closed outright
    if (!turn) return open;
    const both = turn.map((ok, i) => ok && open[i]);
    // If no open lane can make the turn, making the turn wins and the closure is ignored for that driver.
    return both.some(Boolean) ? both : turn;
  }
  return turn;
}

/** How far ahead of a gantry drivers start leaving a closed lane. */
const CLOSURE_WARNING_FT = 450;
/** Where a road's gantry stands: halfway along. */
function gantryDistance(edge: Edge3D): number {
  return edge.length * 0.5;
}

/**
 * The lane a vehicle takes on the next road. A ramp joining from the right enters the through road's right-hand
 * lane (and one joining from the left, its left-hand lane), and a vehicle leaving for a ramp on the right does so
 * from the right-hand lanes. Everything else keeps its lane number.
 */
function mapLaneAcross(from: Edge3D, to: Edge3D, lane: number): number {
  if (from.padEnd && !to.padStart) {
    // merging: `from` is the ramp, `to` the through road
    return clamp(from.padEnd.sideOfMain === 1 ? to.lanes - (from.lanes - lane) : lane, 0, to.lanes - 1);
  }
  if (to.padStart && !from.padEnd) {
    // splitting: `from` is the through road, `to` the ramp
    return clamp(to.padStart.sideOfMain === 1 ? lane - (from.lanes - to.lanes) : lane, 0, to.lanes - 1);
  }
  return clamp(lane, 0, to.lanes - 1);
}

/** Ambulances and police cars run with their lights on: they ignore signals and crossings, and traffic gives way. */
function isEmergencyKind(kind: VehicleKind): boolean {
  return kind === "ambulance" || kind === "police" || kind === "wrecker";
}

/** How fast a driver wants to go relative to the limit: most cruise near it, an ambulance with its siren on well over. */
function cruiseFactor(v: VehicleState): number {
  return isEmergencyKind(v.kind) ? 1.3 : Math.min(v.speedFactor, 1.05);
}

/** How close to the end of a road a car may slip into a reserved lane if that is the only lane that can make its turn. */
const RESERVED_LANE_EXIT_FT = 150;

/** Which lane is set aside: the right-hand one for buses and bikes, the left-hand one for carpools and the express lane. */
function reservedLaneIndex(edge: Edge3D): number {
  return edge.reservedLane === "hov" || edge.reservedLane === "express" ? 0 : edge.lanes - 1;
}

/** About one car in five has a carpool on board: a fixed share by vehicle id, so it takes nothing from the random stream. */
const CARPOOL_SHARE_PERCENT = 20;
function isCarpool(id: number): boolean {
  return id > 0 && (Math.imul(id, 2654435761) >>> 0) % 100 < CARPOOL_SHARE_PERCENT;
}

/**
 * True when this road user may never use `lane` of the edge (the reserved lane belongs to someone else). Ignores the
 * turn exception. `id` is the vehicle's, to tell a carpool from a lone driver; spawning passes 0 (nobody is let in
 * to the carpool lane at the entry).
 */
function isReservedAgainst(edge: Edge3D, lane: number, kind: VehicleKind, id = 0): boolean {
  if (!edge.reservedLane || lane !== reservedLaneIndex(edge)) return false;
  if (isEmergencyKind(kind)) return false;
  switch (edge.reservedLane) {
    case "bus":
      return kind !== "bus";
    case "bike":
      return kind !== "bike";
    case "hov":
      return !(kind === "bus" || (kind === "car" && isCarpool(id)));
    case "express":
      return kind === "truck" || kind === "bike";
  }
}

/** Whether this vehicle heads for the reserved lane on its own: a bus or a bike for its own lane, a bus for the carpool lane (cars choose it by how free it is). */
function wantsReservedLane(edge: Edge3D, kind: VehicleKind): boolean {
  if (edge.reservedLane === "bus") return kind === "bus";
  if (edge.reservedLane === "bike") return kind === "bike";
  if (edge.reservedLane === "hov") return kind === "bus";
  return false;
}

/** As above, plus the real-world exception: right before a junction, anyone may use the lane if it is the only one that makes their turn. */
function laneForbidden(v: VehicleState, edge: Edge3D, lane: number): boolean {
  if (!isReservedAgainst(edge, lane, v.kind, v.id)) return false;
  if (edge.length - v.distanceAlongEdge < RESERVED_LANE_EXIT_FT) {
    const allowed = allowedLanesForNext(v, edge);
    const reserved = reservedLaneIndex(edge);
    if (allowed && !allowed.some((a, i) => a && i !== reserved)) return false;
  }
  return true;
}

const WRONG_LANE_STOP_FT = 70;
const WRONG_LANE_PATIENCE_S = 10;

/** Stop line for a vehicle stuck in a lane that can't make its turn: it waits to merge, then gives up and goes. */
function wrongLaneStopDistance(v: VehicleState, edge: Edge3D): number | null {
  const allowed = allowedLanesForNext(v, edge);
  if (!allowed || allowed[clamp(v.laneIndex, 0, edge.lanes - 1)]) return null;
  if (v.wrongLaneWaitS >= WRONG_LANE_PATIENCE_S) return null;
  const distanceToNode = edge.length - v.distanceAlongEdge;
  return distanceToNode < WRONG_LANE_STOP_FT ? Math.max(distanceToNode - 2, 0.1) : null;
}

function updateWrongLaneTimer(v: VehicleState, edge: Edge3D, dt: number) {
  const allowed = allowedLanesForNext(v, edge);
  if (!allowed || allowed[clamp(v.laneIndex, 0, edge.lanes - 1)]) {
    v.wrongLaneWaitS = 0;
    return;
  }
  if (v.speed < 2 && edge.length - v.distanceAlongEdge < WRONG_LANE_STOP_FT + 10) v.wrongLaneWaitS += dt;
}

function findLeaderGapForVehicle(v: VehicleState, edge: Edge3D): GapInfo {
  const lanes = laneOccupancy.get(edge.id);
  let result: GapInfo = { gap: NO_LEADER_GAP, leaderSpeed: v.speed };

  if (lanes) {
    const laneArr = lanes[clamp(v.laneIndex, 0, lanes.length - 1)];
    const idx = laneArr.indexOf(v.id);
    if (idx >= 0 && idx < laneArr.length - 1) {
      const leader = vehicles.get(laneArr[idx + 1])!;
      result = {
        gap: leader.distanceAlongEdge - leader.length - v.distanceAlongEdge,
        leaderSpeed: leader.speed,
      };
    } else {
      const nextEdgeId = v.routeEdgeIds[v.routeIndex + 1];
      const nextEdge = nextEdgeId ? network?.edgesById.get(nextEdgeId) : undefined;
      const nextLanes = nextEdgeId ? laneOccupancy.get(nextEdgeId) : undefined;
      if (nextEdge && nextLanes) {
        const targetLane = mapLaneAcross(edge, nextEdge, v.laneIndex);
        const nextLaneArr = nextLanes[targetLane];
        if (nextLaneArr.length > 0) {
          const leader = vehicles.get(nextLaneArr[0])!;
          const remaining = edge.length - v.distanceAlongEdge;
          result = {
            gap: remaining + leader.distanceAlongEdge - leader.length,
            leaderSpeed: leader.speed,
          };
        }
      }
    }
  }

  const virtualStop = computeVirtualStopDistance(v, edge);
  if (virtualStop !== null && virtualStop < result.gap) {
    result = { gap: Math.max(virtualStop, 0.1), leaderSpeed: 0 };
  }
  const wrongLaneStop = wrongLaneStopDistance(v, edge);
  if (wrongLaneStop !== null && wrongLaneStop < result.gap) {
    result = { gap: wrongLaneStop, leaderSpeed: 0 };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Curvature-based speed cap: sample the tangent direction a short lookahead
// ahead of the vehicle and behind it; a bigger swing means a tighter curve,
// which caps how fast a driver is willing to take it (independent of the
// road's posted limit) — sharp bends slow traffic down like a real curve
// advisory speed, not just a hard sign-post number.
// ---------------------------------------------------------------------------

const CURVATURE_LOOKAHEAD_FT = 55;
const COMFORTABLE_LATERAL_ACCEL_FTPS2 = 11;

function curvatureSpeedCapFtps(edge: Edge3D, distanceAlongEdge: number): number {
  if (edge.length <= CURVATURE_LOOKAHEAD_FT) return Infinity;
  const t0 = distanceToT(edge, Math.max(0, distanceAlongEdge - CURVATURE_LOOKAHEAD_FT / 2));
  const t1 = distanceToT(edge, Math.min(edge.length, distanceAlongEdge + CURVATURE_LOOKAHEAD_FT / 2));
  fastTangentAt(edge, t0, _curveTangentA);
  fastTangentAt(edge, t1, _curveTangentB);
  const angleRad = _curveTangentA.angleTo(_curveTangentB);
  if (angleRad < 0.015) return Infinity; // effectively straight — no cap
  const turnRadiusFt = CURVATURE_LOOKAHEAD_FT / angleRad;
  return Math.sqrt(turnRadiusFt * COMFORTABLE_LATERAL_ACCEL_FTPS2);
}

/**
 * Sine of the road's slope angle at a point along an edge, positive =
 * climbing in the vehicle's direction of travel. A unit tangent vector's
 * y-component is exactly sin(theta) for theta = atan(rise/run), so this is
 * a direct sample rather than a separate atan/sin computation.
 */
function edgeSinThetaAt(edge: Edge3D, distanceAlongEdge: number): number {
  const t = distanceToT(edge, clamp(distanceAlongEdge, 0, edge.length));
  fastTangentAt(edge, t, _gradeTangent);
  return _gradeTangent.y;
}

function idmAccelForVehicle(v: VehicleState, edge: Edge3D, gapInfo: GapInfo): number {
  const v0 = Math.min(
    isDriven(v) ? Math.max(0.5, drive!.targetFtps) : mphToFtps(effectiveSpeedLimitMph(edge)) * cruiseFactor(v) * conditionSpeedMult(edge) * parkingSpeedMult(edge, v),
    curvatureSpeedCapFtps(edge, v.distanceAlongEdge) * curveGripMult(),
    displacedLeftSpeedCapFtps(v, edge),
    v.maxSpeedFtps
  );
  const deltaV = v.speed - gapInfo.leaderSpeed;
  const params = {
    a: v.maxAccel * (brakeGripMult() < 1 ? 0.9 : 1),
    b: v.comfortBrake * brakeGripMult(),
    s0: v.jamDistance,
    T: v.desiredHeadway * weatherHeadwayMult(),
    v0,
    delta: IDM_DEFAULTS.delta,
  };
  const gradeAccel = gradeAccelFtps2(
    edgeSinThetaAt(edge, v.distanceAlongEdge),
    climbSensitivityFromWeightToPower(v.weightToPowerLbPerHp)
  );
  const free = idmAccel(v.speed, gapInfo.gap, deltaV, v0, params);
  let accel = free + gradeAccel;
  // A heavy truck on a steep climb slows to a crawl; it does not stop for good. Without a floor the grade's pull
  // beats the engine, the truck rolls to a halt, and it blocks the lane for everyone behind it.
  if (gradeAccel < 0 && free > 0 && v.speed <= CRAWL_SPEED_FTPS && accel < 0.4) accel = 0.4;
  return clamp(accel, maxBrakeFtps2(), params.a);
}

/** The slowest a vehicle will hold on a climb it could otherwise not manage (about 10 mph). */
const CRAWL_SPEED_FTPS = mphToFtps(10);

// ---------------------------------------------------------------------------
// Driving a vehicle yourself. The player takes the wheel of one vehicle on the road: they set how fast it goes (the car
// still keeps its distance, stops at lights and crossings, and takes corners at a sane speed, as a driver-assist
// would) and ask for lane changes, which happen only when there is a gap. The route stays the one the driver set out
// on, so the lane they need for the next turn is the lane arrows' business. Nothing here touches the random stream.
// ---------------------------------------------------------------------------

/**
 * How each kind of vehicle drives: how hard the throttle and the brake move the target speed (ft/s per second) and the
 * fastest a driver may ask for as a multiple of the limit (never above the vehicle's own top speed). The vehicle's own
 * acceleration and braking still apply on top, so a bus feels like a bus.
 */
const DRIVE_FEEL: Record<VehicleKind, { throttle: number; brake: number; over: number }> = {
  car: { throttle: 9, brake: 20, over: 1.35 },
  truck: { throttle: 5, brake: 15, over: 1.2 },
  bus: { throttle: 4.5, brake: 14, over: 1.15 },
  bike: { throttle: 3, brake: 10, over: 1.0 },
  ambulance: { throttle: 10, brake: 22, over: 1.5 },
  police: { throttle: 10, brake: 22, over: 1.5 },
  wrecker: { throttle: 6, brake: 16, over: 1.2 },
  debris: { throttle: 0, brake: 0, over: 1 },
};
/** A lane change that cannot happen for this long is dropped. */
const DRIVE_LANE_PATIENCE_S = 2.5;
const DRIVE_BLOCKED_SHOW_S = 1.2;
const DRIVE_HARD_BRAKE_FTPS2 = -9;

interface DriveState {
  id: number;
  /** The speed the driver is asking for (ft/s), moved by the throttle and the brake. */
  targetFtps: number;
  accel: -1 | 0 | 1;
  laneReq: -1 | 0 | 1;
  laneReqAt: number;
  blockedUntil: number;
  startedAt: number;
  /** Time the rest of the route would take at the limit from where the driver took over. */
  idealS: number;
  hardBrakes: number;
  speedingS: number;
  distanceFt: number;
  laneChanges: number;
  lastAccel: number;
}
let drive: DriveState | null = null;
let driveResult: DriveResult | null = null;

function isDriven(v: VehicleState): boolean {
  return drive !== null && v.id === drive.id;
}

function routeTimeAtLimitS(v: VehicleState): number {
  if (!network) return 0;
  let t = 0;
  for (let i = v.routeIndex; i < v.routeEdgeIds.length; i++) {
    const e = network.edgesById.get(v.routeEdgeIds[i]);
    if (!e) continue;
    const remaining = i === v.routeIndex ? Math.max(0, e.length - v.distanceAlongEdge) : e.length;
    t += remaining / Math.max(1, mphToFtps(effectiveSpeedLimitMph(e)));
  }
  return t;
}

function takeWheel(id: number): boolean {
  const v = vehicles.get(id);
  if (!v || v.kind === "debris" || v.frozenUntil > simTime) return false;
  drive = {
    id,
    targetFtps: v.speed,
    accel: 0,
    laneReq: 0,
    laneReqAt: 0,
    blockedUntil: 0,
    startedAt: simTime,
    idealS: routeTimeAtLimitS(v),
    hardBrakes: 0,
    speedingS: 0,
    distanceFt: 0,
    laneChanges: 0,
    lastAccel: 0,
  };
  driveResult = null;
  return true;
}

/** Moves the target speed with the pedals; called once per step. */
function updateDriveTarget(dt: number) {
  if (!drive) return;
  const v = vehicles.get(drive.id);
  if (!v) {
    drive = null;
    return;
  }
  const edge = network?.edgesById.get(v.edgeId);
  const limit = edge ? mphToFtps(effectiveSpeedLimitMph(edge)) : mphToFtps(30);
  const feel = DRIVE_FEEL[v.kind] ?? DRIVE_FEEL.car;
  const ceiling = Math.min(limit * feel.over, v.maxSpeedFtps, MAX_SPEED_FTPS);
  if (drive.accel > 0) drive.targetFtps = Math.min(ceiling, drive.targetFtps + feel.throttle * dt);
  else if (drive.accel < 0) drive.targetFtps = Math.max(0, drive.targetFtps - feel.brake * dt);
  else if (drive.targetFtps > v.speed + 6) drive.targetFtps = v.speed + 6; // lifting off: don't keep a stale target the car is far from
  drive.targetFtps = Math.min(drive.targetFtps, ceiling);
}

/** Carries out the driver's pending lane change if the gaps allow it. Returns true once handled (done, or given up on). */
function applyDriveLaneChange(v: VehicleState, edge: Edge3D) {
  if (!drive || drive.laneReq === 0) return;
  const want = v.laneIndex + drive.laneReq;
  const fail = () => {
    if (simTime - drive!.laneReqAt > DRIVE_LANE_PATIENCE_S) {
      drive!.laneReq = 0;
      drive!.blockedUntil = simTime + DRIVE_BLOCKED_SHOW_S;
    }
  };
  if (want < 0 || want >= edge.lanes || laneForbidden(v, edge, want)) {
    drive.laneReq = 0;
    drive.blockedUntil = simTime + DRIVE_BLOCKED_SHOW_S;
    return;
  }
  const lanes = laneOccupancy.get(edge.id);
  if (!lanes) return;
  const candArr = lanes[want];
  let insertIdx = 0;
  while (insertIdx < candArr.length && vehicles.get(candArr[insertIdx])!.distanceAlongEdge < v.distanceAlongEdge) insertIdx++;
  const newLeader = insertIdx < candArr.length ? vehicles.get(candArr[insertIdx])! : null;
  const newFollower = insertIdx > 0 ? vehicles.get(candArr[insertIdx - 1])! : null;
  if (newLeader && newLeader.distanceAlongEdge - newLeader.length - v.distanceAlongEdge < v.minGap + 2) return fail();
  if (newFollower && v.distanceAlongEdge - v.length - newFollower.distanceAlongEdge < v.minGap + 2) return fail();
  // the car that would end up behind must not have to brake hard for it
  if (newFollower && pairAccel(newFollower, newFollower.distanceAlongEdge, v, edge) < -4) return fail();
  v.laneIndex = want;
  v.laneChangeCooldown = 20;
  drive.laneReq = 0;
  drive.laneChanges++;
}

/** Keeps the drive's trip numbers (distance, hard braking, speeding) as the step runs. */
function trackDrive(v: VehicleState, edge: Edge3D, dt: number) {
  if (!drive || v.id !== drive.id) return;
  drive.distanceFt += v.speed * dt;
  if (v.speed > mphToFtps(effectiveSpeedLimitMph(edge)) * 1.1) drive.speedingS += dt;
  if (v.accel < DRIVE_HARD_BRAKE_FTPS2 && drive.lastAccel >= DRIVE_HARD_BRAKE_FTPS2 && v.speed > 4) drive.hardBrakes++;
  drive.lastAccel = v.accel;
}

/** How the driver did, worked out when they arrive. Out of 100: speeding and hard stops cost points. */
function finishDrive(arrived: boolean): void {
  if (!drive) return;
  const elapsedS = simTime - drive.startedAt;
  const score = Math.max(0, Math.round(100 - drive.hardBrakes * 6 - drive.speedingS * 1.4));
  driveResult = {
    arrived,
    elapsedS,
    idealS: drive.idealS,
    distanceFt: drive.distanceFt,
    hardBrakes: drive.hardBrakes,
    speedingS: drive.speedingS,
    laneChanges: drive.laneChanges,
    score,
  };
  drive = null;
}

/** What the HUD shows while someone drives. */
function driveView(): DriveView | null {
  if (!drive || !network) return null;
  const v = vehicles.get(drive.id);
  const edge = v ? network.edgesById.get(v.edgeId) : undefined;
  if (!v || !edge) return null;
  const nextId = v.routeEdgeIds[v.routeIndex + 1];
  const move = nextId ? edge.nextMoves.get(nextId) ?? "straight" : "end";
  const allowed = allowedLanesForNext(v, edge);
  const stop = computeVirtualStopDistance(v, edge);
  return {
    id: v.id,
    kind: v.kind,
    speedMph: ftpsToMph(v.speed),
    targetMph: ftpsToMph(drive.targetFtps),
    limitMph: effectiveSpeedLimitMph(edge),
    laneIndex: v.laneIndex,
    lanes: edge.lanes,
    nextMove: move,
    toJunctionFt: Math.max(0, edge.length - v.distanceAlongEdge),
    laneOk: !allowed || !!allowed[clamp(v.laneIndex, 0, edge.lanes - 1)],
    laneAllowed: allowed ? allowed.slice() : null,
    stopAheadFt: stop,
    streetName: edge.name ?? "",
    elapsedS: simTime - drive.startedAt,
    idealS: drive.idealS,
    hardBrakes: drive.hardBrakes,
    speedingS: drive.speedingS,
    laneBlocked: simTime < drive.blockedUntil,
    laneChangePending: drive.laneReq !== 0,
    passengers: v.passengers,
    thrusting: drive.accel,
  };
}

// ---------------------------------------------------------------------------
// MOBIL lane changing (within the current edge only)
// ---------------------------------------------------------------------------

function pairAccel(followerV: VehicleState, followerDist: number, leader: VehicleState | null, edge: Edge3D): number {
  const v0 = Math.min(mphToFtps(effectiveSpeedLimitMph(edge)) * cruiseFactor(followerV) * conditionSpeedMult(edge) * parkingSpeedMult(edge, followerV), followerV.maxSpeedFtps);
  let gap = NO_LEADER_GAP;
  let leaderSpeed = followerV.speed;
  if (leader) {
    gap = leader.distanceAlongEdge - leader.length - followerDist;
    leaderSpeed = leader.speed;
  }
  const params = {
    a: followerV.maxAccel * (brakeGripMult() < 1 ? 0.9 : 1),
    b: followerV.comfortBrake * brakeGripMult(),
    s0: followerV.jamDistance,
    T: followerV.desiredHeadway * weatherHeadwayMult(),
    v0,
    delta: IDM_DEFAULTS.delta,
  };
  const gradeAccel = gradeAccelFtps2(
    edgeSinThetaAt(edge, followerDist),
    climbSensitivityFromWeightToPower(followerV.weightToPowerLbPerHp)
  );
  return clamp(idmAccel(followerV.speed, gap, followerV.speed - leaderSpeed, v0, params) + gradeAccel, maxBrakeFtps2(), params.a);
}

function tryLaneChange(v: VehicleState, edge: Edge3D) {
  if (edge.lanes < 2) return;
  const yielding = v.yieldUntil > simTime;
  // A driver in a lane that has been closed ahead looks for a gap every tick rather than waiting out the usual pause.
  const leavingClosed = edge.closedLanes[v.laneIndex] && v.distanceAlongEdge >= gantryDistance(edge) - CLOSURE_WARNING_FT && !isEmergencyKind(v.kind);
  const raging = rageWeaves && v.stuckTimeS >= RAGE_WEAVE_S && !isEmergencyKind(v.kind);
  if (v.laneChangeCooldown > 0 && !yielding && !leavingClosed) {
    v.laneChangeCooldown -= raging ? 4 : 1;
    return;
  }

  const lanes = laneOccupancy.get(edge.id)!;
  const currentArr = lanes[v.laneIndex];
  const idx = currentArr.indexOf(v.id);
  const oldLeader = idx < currentArr.length - 1 ? vehicles.get(currentArr[idx + 1])! : null;
  const oldFollower = idx > 0 ? vehicles.get(currentArr[idx - 1])! : null;

  // If this edge diverges and the vehicle's actual next route edge requires a
  // specific lane range, ramp up an extra merge incentive as the junction
  // approaches so it tends to be in the right lane before it must transition.
  let requiredDirection = 0;
  let mergeUrgency = 0;
  const allowedLanes = allowedLanesForNext(v, edge);
  const distanceToNode = edge.length - v.distanceAlongEdge;
  if (allowedLanes && !allowedLanes[v.laneIndex]) {
    let nearest = -1;
    for (let d = 1; d < edge.lanes && nearest < 0; d++) {
      if (v.laneIndex - d >= 0 && allowedLanes[v.laneIndex - d]) nearest = v.laneIndex - d;
      else if (v.laneIndex + d < edge.lanes && allowedLanes[v.laneIndex + d]) nearest = v.laneIndex + d;
    }
    if (nearest >= 0) {
      requiredDirection = nearest < v.laneIndex ? -1 : 1;
      mergeUrgency = clamp(1 - distanceToNode / 500, 0.15, 1);
      // A closed lane is left well before the end of the road, not just near the junction.
      if (edge.closedLanes[v.laneIndex]) mergeUrgency = Math.max(mergeUrgency, clamp(1 - Math.max(0, gantryDistance(edge) - v.distanceAlongEdge) / CLOSURE_WARNING_FT, 0.4, 1));
    }
  }

  // A driver sitting in a lane reserved for someone else gets out of it as soon as it is safe.
  if (requiredDirection === 0 && edge.reservedLane && laneForbidden(v, edge, v.laneIndex)) {
    // out of the reserved lane, toward the middle of the road
    const away = reservedLaneIndex(edge) === 0 ? 1 : -1;
    if (v.laneIndex + away >= 0 && v.laneIndex + away < edge.lanes) {
      requiredDirection = away;
      mergeUrgency = 1;
    }
  }
  // Buses and bikes head for the lane that was reserved for them, unless a left turn is coming up.
  if (requiredDirection === 0 && edge.reservedLane && wantsReservedLane(edge, v.kind) && v.laneIndex !== reservedLaneIndex(edge) && !isReservedAgainst(edge, reservedLaneIndex(edge), v.kind, v.id)) {
    const nextId = v.routeEdgeIds[v.routeIndex + 1];
    const move = nextId ? edge.nextMoves.get(nextId) : undefined;
    // the left lane is the wrong place for a right turn, and the right lane for a left one
    const turnsAway = edge.reservedLane === "hov" ? move === "right" : move === "left";
    if (!turnsAway || distanceToNode > 400) {
      requiredDirection = reservedLaneIndex(edge) > v.laneIndex ? 1 : -1;
      mergeUrgency = 0.7;
    }
  }

  // A sedan stuck behind a truck that's crawling well under the sedan's own
  // desired speed (typically a heavy semi losing the fight against a steep
  // grade, or a cyclist) gets an extra shove toward overtaking, on top of whatever
  // incentive MOBIL's own acceleration-gain math already produces.
  const followerV0 = mphToFtps(effectiveSpeedLimitMph(edge)) * cruiseFactor(v);
  const truckOvertakeBias =
    !v.isTruck && v.kind !== "bike" && oldLeader && (oldLeader.isTruck || oldLeader.kind === "bike") && oldLeader.speed < followerV0 * 0.6 ? 6 : 0;

  let bestLane = -1;
  let bestIncentive = -Infinity;

  for (const candidateLane of [v.laneIndex - 1, v.laneIndex + 1]) {
    if (candidateLane < 0 || candidateLane >= edge.lanes) continue;
    if (laneForbidden(v, edge, candidateLane)) continue;
    // Nobody moves into a lane that is closed ahead.
    if (edge.closedLanes[candidateLane] && !edge.closedLanes[v.laneIndex] && v.distanceAlongEdge >= gantryDistance(edge) - CLOSURE_WARNING_FT && !isEmergencyKind(v.kind)) continue;
    const candArr = lanes[candidateLane];

    let insertIdx = 0;
    while (
      insertIdx < candArr.length &&
      vehicles.get(candArr[insertIdx])!.distanceAlongEdge < v.distanceAlongEdge
    ) {
      insertIdx++;
    }
    const newLeader = insertIdx < candArr.length ? vehicles.get(candArr[insertIdx])! : null;
    const newFollower = insertIdx > 0 ? vehicles.get(candArr[insertIdx - 1])! : null;

    // Don't drift out of a lane that can make the turn into one that can't, near the junction.
    if (allowedLanes && allowedLanes[v.laneIndex] && !allowedLanes[candidateLane] && distanceToNode < 300) {
      continue;
    }

    if (newLeader && newLeader.distanceAlongEdge - newLeader.length - v.distanceAlongEdge < v.minGap) {
      continue;
    }
    if (newFollower && v.distanceAlongEdge - v.length - newFollower.distanceAlongEdge < v.minGap) {
      continue;
    }

    const targetLaneAccel = pairAccel(v, v.distanceAlongEdge, newLeader, edge);
    const newFollowerAccelBefore = newFollower ? pairAccel(newFollower, newFollower.distanceAlongEdge, newLeader, edge) : 0;
    const newFollowerAccelAfter = newFollower ? pairAccel(newFollower, newFollower.distanceAlongEdge, v, edge) : 0;
    const oldFollowerAccelBefore = oldFollower ? pairAccel(oldFollower, oldFollower.distanceAlongEdge, v, edge) : 0;
    const oldFollowerAccelAfter = oldFollower ? pairAccel(oldFollower, oldFollower.distanceAlongEdge, oldLeader, edge) : 0;

    const candidateDirection = candidateLane > v.laneIndex ? 1 : -1;
    const extraBias =
      (requiredDirection !== 0 && candidateDirection === requiredDirection ? mergeUrgency * (leavingClosed ? 14 : 8) : 0) +
      truckOvertakeBias +
      // Pull out of an ambulance's way, and an ambulance swings round anything slow in front of it.
      (yielding && candidateLane !== v.yieldLane ? 12 : 0) +
      (isEmergencyKind(v.kind) && oldLeader && oldLeader.speed < followerV0 * 0.7 ? 8 : 0);

    const inputs: MobilInputs = {
      currentAccel: v.accel,
      targetLaneAccel,
      oldFollowerAccelBefore,
      oldFollowerAccelAfter,
      newFollowerAccelBefore,
      newFollowerAccelAfter,
      laneBiasDirection: candidateDirection,
      extraBias,
    };

    const result = mobilEvaluate(inputs, raging ? RAGE_MOBIL : MOBIL_DEFAULTS);
    if (result.shouldChange && result.incentive > bestIncentive) {
      bestIncentive = result.incentive;
      bestLane = candidateLane;
    }
  }

  if (bestLane >= 0) {
    v.laneIndex = bestLane;
    v.laneChangeCooldown = randRange(45, 90);
  } else {
    v.laneChangeCooldown = randRange(10, 20);
  }
}

// ---------------------------------------------------------------------------
// Contract (destination speed threshold) tracking
// ---------------------------------------------------------------------------

function recordContractSamples() {
  for (const v of vehicles.values()) {
    if (v.edgeId !== v.destinationEdgeId) continue;
    const samples = contractSamples.get(v.edgeId);
    if (!samples) continue;
    samples.push({ time: simTime, speed: v.speed });
  }
  for (const samples of contractSamples.values()) {
    while (samples.length > 0 && samples[0].time < simTime - 45) samples.shift();
  }
}

function computeContracts(): ContractStatus[] {
  if (!network) return [];
  const result: ContractStatus[] = [];
  for (const edge of network.edges) {
    if (edge.zone?.type !== "destination") continue;
    const samples = contractSamples.get(edge.id) ?? [];
    const avgFtS = samples.length > 0 ? samples.reduce((sum, s) => sum + s.speed, 0) / samples.length : 0;
    const avgMph = ftpsToMph(avgFtS);
    result.push({
      edgeId: edge.id,
      targetSpeedMph: edge.zone.targetSpeedMph,
      actualSpeedMph: avgMph,
      sampleCount: samples.length,
      meetsThreshold: samples.length > 0 && avgMph >= edge.zone.targetSpeedMph,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main physics step
// ---------------------------------------------------------------------------

const MAX_SPEED_FTPS = mphToFtps(90);

/**
 * Picks a moving car in the middle of a longish stretch (not on a ring, not right at a junction) and breaks it
 * down, so it blocks a lane without freezing a whole intersection at once.
 */
function breakDownOneCar(durationS: number) {
  if (!network) return;
  const candidates: VehicleState[] = [];
  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge || edge.isRoundaboutRing || edge.length < 180 || v.frozenUntil > simTime || v.speed < 8) continue;
    const f = v.distanceAlongEdge / edge.length;
    if (f > 0.25 && f < 0.7) candidates.push(v);
  }
  if (candidates.length === 0) return;
  const pick = candidates[Math.floor(rng() * candidates.length)];
  pick.frozenUntil = simTime + Math.max(5, durationS);
}

/** Re-times every entry's next arrival under the current demand scale, so a surge starts (and ends) immediately. */
function resampleSpawns() {
  for (const [entryId, demand] of demandByEntry) nextSpawnTimeByEntry.set(entryId, sampleExponentialInterarrival(demand, entryId));
}

function runDueEvents() {
  while (eventQueue.length > 0 && eventQueue[0].atS <= simTime) {
    const e = eventQueue.shift()!;
    if (e.kind === "breakdown") breakDownOneCar(e.durationS);
    else if (e.kind === "ambulance") ambPending.push(simTime);
    else if (e.kind === "crash") crashPending++;
    else if (e.kind === "dispatchWrecker") {
      const open = incidents.find((i) => !i.wreckerRequested);
      if (open) open.wreckerRequested = true;
    } else if (e.kind === "stall") stallPending++;
    else if (e.kind === "debris") debrisPending++;
    else if (e.kind === "fender") fenderPending++;
    else if (e.kind === "weatherOn") scriptedWeather = e.weather;
    else if (e.kind === "weatherOff") scriptedWeather = null;
    else if (e.kind === "closeOn") for (const id of e.edgeIds) blockedEdges.add(id);
    else if (e.kind === "closeOff") for (const id of e.edgeIds) blockedEdges.delete(id);
    else if (e.kind === "surge") {
      demandScale = e.multiplier;
      resampleSpawns();
    } else {
      demandScale = 1;
      resampleSpawns();
    }
  }
}

function step(dt: number) {
  if (replaying) applyDueReplayActions();
  if (!network) return;
  stepCounter++;
  simTime += dt;
  runDueEvents();

  updateSignalPhases(dt);
  if (crossings.size > 0) updateCrossings();
  // Crashes first: towing a wreck removes vehicles, which must happen before this tick's lane lists are built.
  updateCrashes();
  updateCrashRisk();
  updateElasticDemand();
  updateFlowCombos();
  rebuildLaneOccupancy();
  updateAmbulanceDispatch();
  updateTransit();
  markAmbulanceYielders();
  rebuildNodeApproaches();

  updateDriveTarget(dt);
  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;
    updateWrongLaneTimer(v, edge, dt);
    updateBusDwell(v, edge);
    updateShoulderMode(v, edge, dt);
    const gapInfo = v.shoulder ? { gap: NO_LEADER_GAP, leaderSpeed: v.speed } : findLeaderGapForVehicle(v, edge);
    v.accel = idmAccelForVehicle(v, edge, gapInfo);
    if (v.frozenUntil > simTime) v.accel = -30; // broken down: hold still
  }

  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;
    if (v.frozenUntil > simTime) continue;
    if (isDriven(v)) applyDriveLaneChange(v, edge);
    else tryLaneChange(v, edge);
  }

  const toRemove: number[] = [];
  const gridlockRemoved = new Set<number>();
  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;

    if (v.frozenUntil > simTime) {
      // A breakdown isn't gridlock: it must not tick toward the stuck-vehicle despawn.
      v.speed = 0;
      v.stuckTimeS = 0;
      continue;
    }
    v.speed = clamp(v.speed + v.accel * dt, 0, MAX_SPEED_FTPS);

    if (v.speed < v.minSpeed) v.minSpeed = v.speed;
    if (v.speed < STUCK_SPEED_THRESHOLD_FTPS) {
      v.stuckTimeS += dt;
    } else {
      v.stuckTimeS = 0;
    }
    if (v.stuckTimeS >= GRIDLOCK_DESPAWN_S && !isEmergencyKind(v.kind) && !isDriven(v)) {
      toRemove.push(v.id);
      gridlockRemoved.add(v.id);
      gridlockPenaltyTotal++;
      continue;
    }

    const deltaDist = v.speed * dt;
    v.distanceAlongEdge += deltaDist;
    trackDrive(v, edge, dt);
    if (edge.reservedLane === "express" && v.laneIndex === 0 && v.kind === "car") expressVehicleS += dt;

    let currentEdge = edge;
    while (v.distanceAlongEdge >= currentEdge.length) {
      const overflow = v.distanceAlongEdge - currentEdge.length;
      v.routeIndex += 1;
      let nextEdgeId = v.routeEdgeIds[v.routeIndex];
      // A turn the player banned after this driver set out: find another way from here, if there is one.
      if (nextEdgeId && ((currentEdge.bannedTurns.length > 0 && !currentEdge.nextEdgeIds.includes(nextEdgeId)) || blockedEdges.has(nextEdgeId))) {
        const detour = routeBetween(currentEdge.id, v.destinationEdgeId);
        if (detour && detour.length > 1) {
          v.routeEdgeIds = detour;
          v.routeIndex = 1;
          nextEdgeId = detour[1];
        }
      }
      if (!nextEdgeId) {
        toRemove.push(v.id);
        break;
      }
      const nextEdge = network.edgesById.get(nextEdgeId);
      if (!nextEdge) {
        toRemove.push(v.id);
        break;
      }
      if (currentEdge.nextMoves.get(nextEdgeId) === "left" && (incomingEdgeCountByNode.get(currentEdge.toNodeId) ?? 0) > 1) {
        leftTurnsServed++;
        leftTurnWaitTotalS += v.leftWaitS;
      }
      v.leftWaitS = 0;
      if (currentEdge.meterS > 0 || currentEdge.meterAuto) meterNext.set(currentEdge.id, simTime + meterPeriodS(currentEdge));
      if (network.nodesById.get(currentEdge.toNodeId)?.control?.type === "signal") noteSignalPass(v, currentEdge);
      v.edgeId = nextEdgeId;
      v.laneIndex = mapLaneAcross(currentEdge, nextEdge, v.laneIndex);
      v.distanceAlongEdge = overflow;
      if (nextEdge.reservedLane && isReservedAgainst(nextEdge, v.laneIndex, v.kind, v.id)) {
        const away = reservedLaneIndex(nextEdge) === 0 ? 1 : -1;
        v.laneIndex = clamp(v.laneIndex + away, 0, nextEdge.lanes - 1);
      }
      currentEdge = nextEdge;
    }
  }

  for (const id of toRemove) {
    const v = vehicles.get(id);
    if (drive && id === drive.id) finishDrive(!gridlockRemoved.has(id));
    if (v) {
      // Only trips that actually reached their destination count toward
      // throughput — a gridlock-forced removal is a penalty, not a completion.
      if (v.kind === "police" || v.kind === "wrecker") {
        responders.delete(id);
      } else if (v.kind === "debris") {
        // litter that somehow left its road: not a trip
      } else if (v.kind === "ambulance") {
        if (!gridlockRemoved.has(id)) recordAmbulanceArrival(v);
        ambulances.delete(id);
      } else if (!gridlockRemoved.has(id)) {
        despawnTimestamps.push(simTime);
        recordTripDelay(v);
        completedTripsTotal++;
        peopleMovedTotal += v.passengers;
      }
      releaseVehicle(v);
    }
    vehicles.delete(id);
  }
  while (despawnTimestamps.length > 0 && despawnTimestamps[0] < simTime - 60) {
    despawnTimestamps.shift();
  }

  recordContractSamples();
  updateSpawning();
}

// ---------------------------------------------------------------------------
// Output buffer writing
// ---------------------------------------------------------------------------

/** Semis braking hard on a downgrade, as of the last snapshot. */
const jakeBrakePositions: [number, number, number][] = [];
const MAX_JAKE_BRAKES = 10;
const JAKE_BRAKE_DECEL_FTPS2 = -1.3;
const JAKE_BRAKE_SLOPE = -0.012;

/** Green(blue) >80% of the limit, amber 40-80%, red below 40% — matches the spec's 3-tier congestion coloring, substituting blue for green so the free-flow/stopped contrast survives red-green colorblindness. */
function speedColorInto(ratio: number, out: THREE.Color) {
  const r = clamp(ratio, 0, 1.2);
  if (r > 0.8) {
    out.copy(COLOR_FREE);
  } else if (r >= 0.4) {
    out.copy(COLOR_SLOW);
  } else {
    out.copy(COLOR_STOP);
  }
}

const edgeSpeedRatioSum = new Map<string, number>();
const edgeSpeedRatioCount = new Map<string, number>();
const edgeSpeedSumMph = new Map<string, number>();

function writeSnapshot(
  buf: BufferSet,
  collectStats: boolean
): {
  activeCount: number;
  avgSpeedFtS: number;
  gridlockMarkers: [number, number, number][];
  incidentMarkers: [number, number, number][];
  ambulancePositions: [number, number, number][];
} {
  if (!network) return { activeCount: 0, avgSpeedFtS: 0, gridlockMarkers: [], incidentMarkers: [], ambulancePositions: [] };
  if (collectStats) {
    edgeSpeedRatioSum.clear();
    edgeSpeedRatioCount.clear();
    edgeSpeedSumMph.clear();
  }
  const gridlockMarkers: [number, number, number][] = [];
  const incidentMarkers: [number, number, number][] = [];
  const ambulancePositions: [number, number, number][] = [];
  jakeBrakePositions.length = 0;
  const angry: { slot: number; s: number }[] = [];
  let i = 0;
  let speedSum = 0;
  for (const v of vehicles.values()) {
    if (i >= MAX_VEHICLES) break;
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;

    const t = distanceToT(edge, v.distanceAlongEdge);
    laneCenterPointAt(edge, t, v.laneIndex, _tangent, _right, _pos);
    // Roads meet at a node but each lane's offset belongs to its own road, so a turning car would snap sideways
    // as it crosses. Easing it toward the next road's lane start over the last few feet removes the jump.
    const remaining = edge.length - v.distanceAlongEdge;
    if (remaining < JUNCTION_BLEND_FT) {
      const nextEdge = network.edgesById.get(v.routeEdgeIds[v.routeIndex + 1] ?? "");
      if (nextEdge) {
        const k = clamp(1 - remaining / JUNCTION_BLEND_FT, 0, 1);
        const ease = k * k * (3 - 2 * k);
        laneCenterPointAt(edge, 1, v.laneIndex, _tmpTangent, _right, _posEnd);
        laneCenterPointAt(nextEdge, 0, mapLaneAcross(edge, nextEdge, v.laneIndex), _tangentNext, _rightNext, _posNext);
        _pos.addScaledVector(_posNext.sub(_posEnd), ease);
        _tangent.lerp(_tangentNext, ease);
        if (_tangent.lengthSq() > 1e-6) _tangent.normalize();
      }
    }
    // The renderer builds each kind of vehicle's own shape, standing on the road: the matrix carries only where it is
    // and which way it faces, plus two spare slots (below) for what kind it is and how long.
    _pos.y += 0.1;
    if (v.shoulder) _pos.addScaledVector(_right, (edge.lanes * edge.laneWidthFt) / 2 + 3.5);

    const broken = v.frozenUntil > simTime && v.kind !== "police" && v.kind !== "wrecker" && v.kind !== "debris";
    // A loaded semi slowing down a long hill brakes with its engine: a rumble the sound layer plays near the camera.
    if (v.kind === "truck" && v.accel < JAKE_BRAKE_DECEL_FTPS2 && v.speed > 25 && jakeBrakePositions.length < MAX_JAKE_BRAKES && edgeSinThetaAt(edge, v.distanceAlongEdge) < JAKE_BRAKE_SLOPE) {
      jakeBrakePositions.push([_pos.x, _pos.y, _pos.z]);
    }
    if (v.kind === "ambulance") ambulancePositions.push([_pos.x, _pos.y, _pos.z]);
    if (broken || v.kind === "debris") {
      incidentMarkers.push([_pos.x, _pos.y, _pos.z]);
    } else if (v.stuckTimeS >= GRIDLOCK_WARNING_S) {
      gridlockMarkers.push([_pos.x, _pos.y, _pos.z]);
    }

    _quat.setFromUnitVectors(FORWARD_AXIS, _tangent);
    _scale.set(1, 1, 1);
    _matrix.compose(_pos, _quat, _scale);
    _matrix.toArray(buf.matrices, i * 16);
    // Slots 3 and 7 are always 0 in a transform; here they carry the vehicle's kind code and its length in feet. The
    // renderer reads them and clears them before the matrix reaches the GPU.
    buf.matrices[i * 16 + 3] = VEHICLE_KIND_CODE[v.kind];
    buf.matrices[i * 16 + 7] = v.length;
    // The vehicle's id rides in a third spare slot, so anything that follows a vehicle over time (light trails) can tell them apart.
    buf.matrices[i * 16 + 11] = v.id;

    const speedLimitFtps = mphToFtps(effectiveSpeedLimitMph(edge));
    const ratio = v.speed / speedLimitFtps;
    if (broken) {
      // Hazard red, whatever the paint or heatmap would say.
      buf.colors[i * 3] = 1;
      buf.colors[i * 3 + 1] = 0.12;
      buf.colors[i * 3 + 2] = 0.12;
    } else if (v.kind === "wrecker") {
      // Amber, flashing.
      const on = Math.floor(simTime * 3) % 2 === 0;
      buf.colors[i * 3] = on ? 1 : 0.55;
      buf.colors[i * 3 + 1] = on ? 0.72 : 0.38;
      buf.colors[i * 3 + 2] = on ? 0.1 : 0.05;
    } else if (v.kind === "police") {
      // Blue and white, four times a second.
      const blue = Math.floor(simTime * 4) % 2 === 0;
      buf.colors[i * 3] = blue ? 0.15 : 1;
      buf.colors[i * 3 + 1] = blue ? 0.3 : 1;
      buf.colors[i * 3 + 2] = 1;
    } else if (v.kind === "ambulance") {
      // Lights flashing red and blue, four times a second.
      const red = Math.floor(simTime * 4) % 2 === 0;
      buf.colors[i * 3] = red ? 1 : 0.15;
      buf.colors[i * 3 + 1] = red ? 0.1 : 0.35;
      buf.colors[i * 3 + 2] = red ? 0.1 : 1;
    } else if (heatmapColorMode) {
      speedColorInto(ratio, _color);
      _color.toArray(buf.colors, i * 3);
    } else {
      buf.colors[i * 3] = v.bodyColorR;
      buf.colors[i * 3 + 1] = v.bodyColorG;
      buf.colors[i * 3 + 2] = v.bodyColorB;
    }

    // Dim cruising glow that brightens toward white-hot as deceleration
    // ramps from light braking (-1 ft/s^2) up to the hard-brake threshold,
    // so a following driver (or player) can read braking intensity at a glance.
    const brakeT = clamp((-v.accel - 1) / (-HARD_BRAKE_ACCEL_THRESHOLD - 1), 0, 1);
    const lightT = broken ? 1 : brakeT;
    buf.taillightColors[i * 3] = 0.55 + lightT * 1.05;
    buf.taillightColors[i * 3 + 1] = 0.05 + lightT * 0.2;
    buf.taillightColors[i * 3 + 2] = 0.05 + lightT * 0.2;

    if (collectStats) {
      edgeSpeedRatioSum.set(edge.id, (edgeSpeedRatioSum.get(edge.id) ?? 0) + ratio);
      edgeSpeedRatioCount.set(edge.id, (edgeSpeedRatioCount.get(edge.id) ?? 0) + 1);
      edgeSpeedSumMph.set(edge.id, (edgeSpeedSumMph.get(edge.id) ?? 0) + ftpsToMph(v.speed));
    }

    if (v.stuckTimeS >= RAGE_AFTER_S && v.frozenUntil <= simTime && (v.kind === "car" || v.kind === "truck" || v.kind === "bus")) angry.push({ slot: i, s: v.stuckTimeS });

    speedSum += v.speed;
    i++;
  }
  // The longest-stopped drivers get a marker each, spread out so a standing queue shows a few faces rather than a carpet of them.
  rageCount = angry.length;
  angry.sort((a, b) => b.s - a.s);
  const picked: [number, number, number][] = [];
  for (const a of angry) {
    if (picked.length >= MAX_RAGE_MARKERS) break;
    const x = buf.matrices[a.slot * 16 + 12];
    const y = buf.matrices[a.slot * 16 + 13];
    const z = buf.matrices[a.slot * 16 + 14];
    if (picked.some((p) => Math.hypot(p[0] - x, p[2] - z) < RAGE_MARKER_SPACING_FT)) continue;
    picked.push([x, y, z]);
  }
  rageMarkers = picked;
  return { activeCount: i, avgSpeedFtS: i > 0 ? speedSum / i : 0, gridlockMarkers, incidentMarkers, ambulancePositions };
}

function computeEdgeSpeedRatios(): EdgeSpeedRatio[] {
  const result: EdgeSpeedRatio[] = [];
  for (const [edgeId, sum] of edgeSpeedRatioSum) {
    const count = edgeSpeedRatioCount.get(edgeId) ?? 1;
    result.push([edgeId, sum / count]);
  }
  return result;
}

function computeEdgeTrafficStatsList(): EdgeTrafficStats[] {
  if (!network) return [];
  const result: EdgeTrafficStats[] = [];
  for (const edge of network.edges) {
    const count = edgeSpeedRatioCount.get(edge.id) ?? 0;
    const avgSpeedMph = count > 0 ? (edgeSpeedSumMph.get(edge.id) ?? 0) / count : 0;
    result.push(computeEdgeTrafficStats(edge.id, count, avgSpeedMph, edge.length, edge.lanes, edge.roadClassId));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Problem detection: flag edges stuck well under the speed limit for a
// sustained stretch, with hysteresis so a momentary red light doesn't flicker
// a marker on and off. This is the "find the problem" signal the heatmap
// alone doesn't give you — it survives a paused/opt-in heatmap being off.
// ---------------------------------------------------------------------------

const CONGESTION_LOW_RATIO = 0.35;
const CONGESTION_RECOVER_RATIO = 0.55;
const CONGESTION_SUSTAIN_S = 4;

const congestionTimer = new Map<string, number>();
const problemEdges = new Set<string>();
let lastSnapshotSimTime = 0;

function updateCongestionState(deltaSimTime: number) {
  if (!network) return;
  for (const edge of network.edges) {
    const count = edgeSpeedRatioCount.get(edge.id) ?? 0;
    if (count === 0) {
      congestionTimer.set(edge.id, 0);
      problemEdges.delete(edge.id);
      continue;
    }
    const ratio = (edgeSpeedRatioSum.get(edge.id) ?? 0) / count;
    if (ratio <= CONGESTION_LOW_RATIO) {
      const next = (congestionTimer.get(edge.id) ?? 0) + deltaSimTime;
      congestionTimer.set(edge.id, next);
      if (next >= CONGESTION_SUSTAIN_S) problemEdges.add(edge.id);
    } else if (ratio >= CONGESTION_RECOVER_RATIO) {
      congestionTimer.set(edge.id, 0);
      problemEdges.delete(edge.id);
    }
    // Between the two thresholds: hold steady, neither accumulating nor clearing.
  }
}

/** How often the heavy per-edge statistics are recomputed and sent. Everything the HUD shows from them updates only ~5x/s anyway. */
const STATS_INTERVAL_MS = 200;
let lastStatsPostMs = 0;
/** Set whenever something changed while paused (network, patches, run state) so the main thread gets one fresh snapshot instead of a stream of identical ones. */
let snapshotDirty = true;

function postSnapshot(forceStats: boolean) {
  const now = performance.now();
  const withStats = forceStats || now - lastStatsPostMs >= STATS_INTERVAL_MS;
  const buf = acquireBufferSet();
  const { activeCount, avgSpeedFtS, gridlockMarkers, incidentMarkers, ambulancePositions } = writeSnapshot(buf, withStats);
  let stats: TickStats | undefined;
  if (withStats) {
    lastStatsPostMs = now;
    const deltaSimTime = Math.max(0, simTime - lastSnapshotSimTime);
    lastSnapshotSimTime = simTime;
    updateCongestionState(deltaSimTime);
    updateQueueStats();
    stats = {
      contracts: computeContracts(),
      edgeSpeedRatios: computeEdgeSpeedRatios(),
      problemEdgeIds: Array.from(problemEdges),
      edgeTrafficStats: computeEdgeTrafficStatsList(),
      gridlockPenaltyTotal,
      gridlockMarkers,
      incidentMarkers,
      signalHeads: signalHeadStates(),
      meters: meterStates(),
    };
  }
  const matricesBuffer = buf.matrices.buffer as ArrayBuffer;
  const colorsBuffer = buf.colors.buffer as ArrayBuffer;
  const taillightColorsBuffer = buf.taillightColors.buffer as ArrayBuffer;
  const message: WorkerOutMessage = {
    type: "tick",
    matrices: matricesBuffer,
    colors: colorsBuffer,
    taillightColors: taillightColorsBuffer,
    activeCount,
    simTime,
    avgSpeedFtS,
    throughputLastMinute: despawnTimestamps.length,
    spawnedTotal,
    completedTripsTotal,
    peopleMovedTotal,
    tripDelayTotalS,
    tripFreeFlowTotalS,
    tripsTimed,
    queueNowFt,
    queuePeakFt,
    expressVehicleS,
    transit: transitStats(),
    drive: driveView(),
    driveResult,
    demandIndex: demandIndex(),
    elasticOn: elasticDemand,
    crashRiskOn: crashRisk,
    pedWaitsOn: pedWaits,
    riskCrashes,
    pedWait: { arrivals: pedArrivals, waitTotalS: pedWaitTotalS, gaveUp: pedGaveUp },
    closedEdges: Array.from(blockedEdges),
    runId,
    actions: takeNewActions(),
    pedServedTotal,
    pedIncidentsTotal,
    pedCrossings: activeCrossingViews(),
    emergency: emergencyStats(),
    crashes: crashStats(),
    ambulances: ambulancePositions,
    incidents: incidentViews(),
    jakeBrakes: jakeBrakePositions.slice(),
    rageMarkers,
    rageCount,
    combos: combosTotal,
    weather: currentWeather(),
    clockHour: clockHour(),
    stats,
  };
  ctx.postMessage(message, [matricesBuffer, colorsBuffer, taillightColorsBuffer]);
}

// ---------------------------------------------------------------------------
// Fixed-timestep loop, decoupled from render cadence
// ---------------------------------------------------------------------------

// 30 Hz is plenty: the sim steps at 30 Hz and the renderer is capped at or below it for low-end machines.
const LOOP_INTERVAL_MS = 1000 / 30;
const MAX_STEPS_PER_FRAME = 40;

function loopTick() {
  const now = performance.now();
  let realDt = (now - lastWallTimeMs) / 1000;
  lastWallTimeMs = now;
  if (realDt > 0.25) realDt = 0.25;

  if (running) {
    accumulator += realDt * speedMultiplier;
    let steps = 0;
    while (accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      step(SIM_DT);
      accumulator -= SIM_DT;
      steps++;
    }
  }

  // While paused nothing moves, so send one snapshot per change rather than a constant stream.
  if (running) {
    postSnapshot(false);
  } else if (snapshotDirty) {
    snapshotDirty = false;
    postSnapshot(true);
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(msg: WorkerInMessage) {
  switch (msg.type) {
    case "reset":
      resetRun();
      break;
    case "updateNetwork":
      onNetworkUpdated(msg);
      break;
    case "setRunning":
      running = msg.running;
      lastWallTimeMs = performance.now();
      break;
    case "setSpeedMultiplier":
      speedMultiplier = msg.value;
      break;
    case "patchEdges":
      if (network) {
        for (const p of msg.edges) {
          const edge = network.edgesById.get(p.id);
          if (edge) patchEdge(edge, network.edgesById, p);
        }
        rebuildMeteredEdges();
        rebuildCrossings();
      }
      break;
    case "setTrafficMix":
      busShare = Math.max(0, Math.min(0.5, msg.bus));
      bikeShare = Math.max(0, Math.min(0.5, msg.bike));
      break;
    case "patchNodes":
      if (network) {
        for (const p of msg.nodes) {
          const node = network.nodesById.get(p.id);
          if (!node) continue;
          if (p.control) node.control = p.control;
          else delete node.control;
          signalPhaseState.delete(p.id);
        }
      }
      break;
    case "breakdown":
      breakDownOneCar(msg.durationS);
      break;
    case "ambulance":
      ambPending.push(simTime);
      break;
    case "crash":
      crashPending++;
      break;
    case "incident":
      if (msg.kind === "stall") stallPending++;
      else if (msg.kind === "debris") {
        debrisPending++;
        debrisEdges.push(msg.edgeId ?? "");
      }
      else fenderPending++;
      break;
    case "dispatchWrecker": {
      const inc = incidents.find((i) => i.id === msg.incidentId);
      if (inc && !inc.wreckerRequested) inc.wreckerRequested = true;
      break;
    }
    case "setRageWeaves":
      rageWeaves = msg.enabled;
      break;
    case "setLeftTurnsYield":
      leftTurnsYield = msg.enabled;
      break;
    case "setTransit":
      transitLines = msg.lines;
      rebuildLinesOnEdge();
      for (const id of Array.from(nextBusAt.keys())) if (!transitLines.some((l) => l.id === id)) nextBusAt.delete(id);
      break;
    case "drive":
      if (msg.action === "take") {
        if (!takeWheel(msg.id)) driveResult = null;
      } else if (drive) {
        drive = null;
      }
      break;
    case "driveInput":
      if (drive) {
        if (msg.accel !== undefined) drive.accel = msg.accel;
        if (msg.lane !== undefined && msg.lane !== 0) {
          drive.laneReq = msg.lane;
          drive.laneReqAt = simTime;
        }
      }
      break;
    case "setElasticDemand":
      elasticDemand = msg.enabled;
      if (!msg.enabled) resetElasticDemand();
      resampleSpawns();
      break;
    case "setCrashRisk":
      crashRisk = msg.enabled;
      break;
    case "setPedWaits":
      pedWaits = msg.enabled;
      break;
    case "setDarkness":
      darkness = Math.max(0, Math.min(1, msg.level));
      break;
    case "setWeather":
      manualWeather = msg.weather;
      break;
    case "setDayCycle":
      dayCycleOn = msg.enabled;
      dayStartHour = msg.startHour;
      dayLengthS = Math.max(60, msg.dayLengthS);
      resampleSpawns();
      break;
    case "scheduleEvents": {
      eventQueue = [];
      for (const e of msg.events) {
        if (e.kind === "ambulance") eventQueue.push({ atS: e.atS, kind: "ambulance" });
        else if (e.kind === "crash") eventQueue.push({ atS: e.atS, kind: "crash" });
        else if (e.kind === "stall" || e.kind === "debris" || e.kind === "fender" || e.kind === "dispatchWrecker") eventQueue.push({ atS: e.atS, kind: e.kind });
        else if (e.kind === "weather") {
          eventQueue.push({ atS: e.atS, kind: "weatherOn", weather: e.weather });
          eventQueue.push({ atS: e.atS + e.durationS, kind: "weatherOff" });
        } else if (e.kind === "roadClosure") {
          eventQueue.push({ atS: e.atS, kind: "closeOn", edgeIds: e.edgeIds });
          eventQueue.push({ atS: e.atS + e.durationS, kind: "closeOff", edgeIds: e.edgeIds });
        } else eventQueue.push(e.kind === "breakdown" ? { atS: e.atS, kind: "breakdown", durationS: e.durationS } : { atS: e.atS, kind: "surge", multiplier: e.multiplier });
        if (e.kind === "surge") eventQueue.push({ atS: e.atS + e.durationS, kind: "surgeEnd" });
      }
      eventQueue.sort((a, b) => a.atS - b.atS);
      break;
    }
    case "setMaxVehicles":
      maxVehicles = Math.max(0, Math.min(MAX_VEHICLES, Math.floor(msg.value)));
      break;
    case "setDemand":
      demandByEntry.set(msg.edgeId, msg.vehiclesPerHour);
      if (!nextSpawnTimeByEntry.has(msg.edgeId)) {
        nextSpawnTimeByEntry.set(msg.edgeId, sampleExponentialInterarrival(msg.vehiclesPerHour, msg.edgeId));
      }
      break;
    case "setColorMode":
      heatmapColorMode = msg.heatmap;
      break;
    case "returnBuffers":
      bufferPool.push({
        matrices: new Float32Array(msg.matrices),
        colors: new Float32Array(msg.colors),
        taillightColors: new Float32Array(msg.taillightColors),
      });
      break;
  }
}

// ---------------------------------------------------------------------------
// Recording and replay. The sim is deterministic: the same network, seed and the same player actions at the same sim
// times give the same run. So a run is recorded as the actions that changed it (each stamped with the sim clock it
// was applied at), and a replay is that script played back into a fresh run, exactly, with no per-vehicle data to
// store. The log starts, at the moment of a reset, with the settings that persist from run to run.
// ---------------------------------------------------------------------------

const LOGGED_TYPES = new Set<WorkerInMessage["type"]>([
  "updateNetwork",
  "patchEdges",
  "patchNodes",
  "setDemand",
  "breakdown",
  "ambulance",
  "crash",
  "incident",
  "dispatchWrecker",
  "setTransit",
  "setWeather",
  "setDarkness",
  "setTrafficMix",
  "setLeftTurnsYield",
  "setRageWeaves",
  "scheduleEvents",
  "setDayCycle",
  "setMaxVehicles",
  "setElasticDemand",
  "setCrashRisk",
  "setPedWaits",
  "drive",
  "driveInput",
]);
const MAX_LOGGED_ACTIONS = 20000;
/** Counts runs (resets), so the main thread can tell when the actions it is receiving belong to a new one. */
let runId = 0;
let actionLog: LoggedAction[] = [];
let actionLogSent = 0;
let replayQueue: LoggedAction[] = [];
let replaying = false;

function logAction(msg: WorkerInMessage) {
  if (actionLog.length < MAX_LOGGED_ACTIONS) actionLog.push({ at: simTime, msg });
}

/** Starts a fresh log, opening it with the settings that carry over from one run to the next. */
function startActionLog() {
  actionLog = [];
  actionLogSent = 0;
  runId++;
  logAction({ type: "setMaxVehicles", value: maxVehicles });
  logAction({ type: "setTransit", lines: transitLines });
  logAction({ type: "setWeather", weather: manualWeather });
  logAction({ type: "setDarkness", level: darkness });
  logAction({ type: "setTrafficMix", bus: busShare, bike: bikeShare });
  logAction({ type: "setDayCycle", enabled: dayCycleOn, startHour: dayStartHour, dayLengthS });
  logAction({ type: "setElasticDemand", enabled: elasticDemand });
  logAction({ type: "setCrashRisk", enabled: crashRisk });
  logAction({ type: "setPedWaits", enabled: pedWaits });
}

/** Actions logged since the last snapshot. */
function takeNewActions(): LoggedAction[] | undefined {
  if (actionLog.length <= actionLogSent) return undefined;
  const fresh = actionLog.slice(actionLogSent);
  actionLogSent = actionLog.length;
  return fresh;
}

/** Plays back the replay actions that have come due, in order. Runs at the top of a step, where the original run's messages were handled. */
function applyDueReplayActions() {
  while (replayQueue.length > 0 && replayQueue[0].at <= simTime) {
    const a = replayQueue.shift()!;
    try {
      handleMessage(a.msg);
    } catch {
      // a damaged action in a replay file must not take the simulator down: skip it
    }
  }
}

ctx.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (msg.type !== "returnBuffers" && msg.type !== "setSpeedMultiplier" && msg.type !== "setMaxVehicles") snapshotDirty = true;
  if (msg.type === "replay") {
    // stable by time, so actions logged at the same moment keep their order
    replayQueue = msg.actions.map((a, i) => ({ a, i })).sort((x, y) => x.a.at - y.a.at || x.i - y.i).map((x) => x.a);
    replaying = true;
    return;
  }
  if (msg.type === "reset") {
    replayQueue = [];
    replaying = false;
    handleMessage(msg);
    startActionLog();
    return;
  }
  // During a replay the only changes are the script's.
  if (replaying && LOGGED_TYPES.has(msg.type)) return;
  if (LOGGED_TYPES.has(msg.type)) logAction(msg);
  handleMessage(msg);
};

// The headless harness sets this before importing the worker to get at the live state when diagnosing jams.
const debugSlot = (globalThis as { __simDebug?: Record<string, unknown> }).__simDebug;
if (debugSlot) {
  debugSlot.state = () => ({ vehicles, network, laneOccupancy, signalPhaseState, nodeApproaches, simTime, incidents, leftStats: () => ({ served: leftTurnsServed, waitS: leftTurnWaitTotalS }) });
  // Steps the sim directly (no timers), for tests that need exactly the same moments from run to run.
  debugSlot.advance = (untilS: number) => {
    while (simTime < untilS - 1e-9) step(SIM_DT);
  };
  debugSlot.actions = () => actionLog;
  debugSlot.totals = () => ({ simTime, trips: completedTripsTotal, people: peopleMovedTotal, delayS: tripDelayTotalS, spawned: spawnedTotal, active: vehicles.size });
  debugSlot.stopFor = (v: VehicleState, edge: Edge3D) => ({
    junction: junctionStopDistance(v, edge),
    crossing: crossingStopDistance(v, edge),
    busStop: busStopDistance(v, edge),
    wrongLane: wrongLaneStopDistance(v, edge),
    gap: findLeaderGapForVehicle(v, edge),
  });
}

lastWallTimeMs = performance.now();
setInterval(loopTick, LOOP_INTERVAL_MS);

const readyMessage: WorkerOutMessage = { type: "ready" };
ctx.postMessage(readyMessage);
