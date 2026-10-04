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
  type CrashStats,
  type EmergencyStats,
  type IncidentView,
  type TickStats,
  type TransitLine,
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
  phase: "A" | "B" | "ALLRED";
  timer: number;
  nextPhase: "A" | "B";
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
  | { atS: number; kind: "ambulance" }
  | { atS: number; kind: "crash" }
  | { atS: number; kind: "stall" }
  | { atS: number; kind: "debris" }
  | { atS: number; kind: "fender" }
  | { atS: number; kind: "weatherOn"; weather: Exclude<Weather, "clear"> }
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

function sampleExponentialInterarrival(vehiclesPerHour: number): number {
  if (vehiclesPerHour <= 0) return simTime + 1e9;
  const ratePerSecond = (vehiclesPerHour * demandScale * dayDemandMultiplier()) / 3600;
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
        nextSpawnTimeByEntry.set(edge.id, sampleExponentialInterarrival(edge.zone.demandVehPerHour));
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

  congestionTimer.clear();
  problemEdges.clear();
  lastSnapshotSimTime = simTime;
  gridlockPenaltyTotal = 0;
  completedTripsTotal = 0;
  peopleMovedTotal = 0;
  rebuildCrossings();

  for (const [id, v] of vehicles) {
    if (!network.edgesById.has(v.edgeId)) {
      releaseVehicle(v);
      vehicles.delete(id);
      ambulances.delete(id);
      responders.delete(id);
    }
  }
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
  pedServedTotal = 0;
  pedIncidentsTotal = 0;
  crossings.clear();
  crossingByEdge.clear();
  resetEmergency();
  resetCrashes();
  leftTurnsServed = 0;
  leftTurnWaitTotalS = 0;
  nextBusAt.clear();
  scriptedWeather = null;
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

  const destinations = network.edges.filter((e) => e.zone?.type === "destination" && e.id !== entryEdgeId);
  if (destinations.length === 0) return;

  // Start at a random destination but fall through to the next reachable one, so entries in a
  // partly disconnected network still spawn at their full rate.
  const startIdx = Math.floor(rng() * destinations.length);
  let destination = destinations[startIdx];
  let route: string[] | null = null;
  for (let k = 0; k < destinations.length; k++) {
    const candidate = destinations[(startIdx + k) % destinations.length];
    const r = computeRoute(network, entryEdgeId, candidate.id);
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

function spawnVehicle(edge: Edge3D, laneIndex: number, route: string[], destinationEdgeId: string, forcedKind: VehicleKind | null = null) {
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

  vehicles.set(v.id, v);
  spawnedTotal++;
}

function updateSpawning() {
  for (const [entryId, demand] of demandByEntry) {
    let nextTime = nextSpawnTimeByEntry.get(entryId) ?? simTime + 1e9;
    let guard = 0;
    while (simTime >= nextTime && guard < 8) {
      trySpawn(entryId);
      nextTime = sampleExponentialInterarrival(demand);
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

/** Where in its cycle a light starts: offsetS seconds in (green A, all-red, green B, all-red, repeat). */
function initialSignalState(ctrl: { greenDurationS: number; allRedDurationS: number; offsetS?: number }): SignalPhaseState {
  const g = ctrl.greenDurationS;
  const r = ctrl.allRedDurationS;
  const cycle = 2 * (g + r);
  let t = cycle > 0 ? (((ctrl.offsetS ?? 0) % cycle) + cycle) % cycle : 0;
  if (t < g) return { phase: "A", timer: t, nextPhase: "B" };
  t -= g;
  if (t < r) return { phase: "ALLRED", timer: t, nextPhase: "B" };
  t -= r;
  if (t < g) return { phase: "B", timer: t, nextPhase: "A" };
  t -= g;
  return { phase: "ALLRED", timer: t, nextPhase: "A" };
}

function updateSignalPhases(dt: number) {
  if (!network) return;
  for (const [nodeId, node] of network.nodesById) {
    if (node.control?.type !== "signal") continue;
    const ctrl = node.control;
    let state = signalPhaseState.get(nodeId);
    if (!state) {
      state = initialSignalState(ctrl);
      signalPhaseState.set(nodeId, state);
    }
    state.timer += dt;
    const duration = state.phase === "ALLRED" ? ctrl.allRedDurationS : ctrl.greenDurationS;
    if (state.timer >= duration) {
      state.timer = 0;
      if (state.phase === "ALLRED") {
        state.phase = state.nextPhase;
      } else {
        state.nextPhase = state.phase === "A" ? "B" : "A";
        state.phase = "ALLRED";
      }
    }
  }
}

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
  walkStart: number;
  walkUntil: number;
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
        walkStart: old?.walkStart ?? -1e9,
        walkUntil: old?.walkUntil ?? -1e9,
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

function updateCrossings() {
  for (const c of crossings.values()) {
    if (simTime < c.walkUntil || simTime < c.nextAt) continue;
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
  return d > 0.5 && d <= CROSSING_APPROACH_FT ? d : null;
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
      const r = computeRoute(network, edge.id, cand.id);
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
const BUS_DWELL_S = 7;
const BUS_STOP_APPROACH_FT = 110;
const BUS_RIDERSHIP_GAIN = 1.12;
const BUS_MAX_RIDERS = 70;

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

/** Runs a bus's boarding timer once it has stopped at its stop, and marks the stop served when the wait is over. */
function updateBusDwell(v: VehicleState, edge: Edge3D) {
  if (v.kind !== "bus" || !edge.busStop || v.stopServedEdge === edge.id) return;
  const d = edge.length * BUS_STOP_AT - v.distanceAlongEdge;
  if (d < -2) {
    v.stopServedEdge = edge.id; // overshot (it joined the road past the stop): don't hold it up for one it can't use
    v.dwellUntil = 0;
    return;
  }
  if (v.dwellUntil === 0) {
    if (d < 16 && v.speed < 1.5) v.dwellUntil = simTime + BUS_DWELL_S;
    return;
  }
  if (simTime >= v.dwellUntil) {
    v.stopServedEdge = edge.id;
    v.dwellUntil = 0;
    v.passengers = Math.min(BUS_MAX_RIDERS, Math.round(v.passengers * BUS_RIDERSHIP_GAIN));
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
        spawnVehicle(first, lane, line.edgeIds, line.edgeIds[line.edgeIds.length - 1], "bus");
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
function causeDebris(): boolean {
  if (!network) return false;
  const edges = network.edges.filter((e) => !e.isRoundaboutRing && !e.isTexasTurnaround && e.length >= 300 && vehicles.size < maxVehicles);
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
        const r = entry.id === inc.edgeId ? [entry.id] : computeRoute(network!, entry.id, inc.edgeId);
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
    const toScene = entry.id === inc.edgeId ? [entry.id] : computeRoute(network, entry.id, inc.edgeId);
    if (!toScene) continue;
    let onward: string[] | null = null;
    let destId = "";
    for (const d of destinations) {
      if (d.id === inc.edgeId) continue;
      const r = computeRoute(network, inc.edgeId, d.id);
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
    if (causeDebris()) debrisPending--;
    else break;
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
  const nodeId = edge.toNodeId;
  const incomingCount = incomingEdgeCountByNode.get(nodeId) ?? 0;
  if (incomingCount <= 1) return null;

  const distanceToNode = edge.length - v.distanceAlongEdge;
  if (distanceToNode > JUNCTION_APPROACH_FT || distanceToNode < JUNCTION_COMMIT_FT) return null;

  const node = network.nodesById.get(nodeId);
  const control = node?.control;

  if (control?.type === "signal") {
    const phaseState = signalPhaseState.get(nodeId);
    if (!phaseState) return null;
    const myGroup: "A" | "B" | null = control.groupA.includes(edge.id)
      ? "A"
      : control.groupB.includes(edge.id)
        ? "B"
        : null;
    if (myGroup === null) return null;
    if (phaseState.phase === "ALLRED" || phaseState.phase !== myGroup) {
      return distanceToNode;
    }
    if (leftTurnsYield && mustYieldLeft(v, edge, node!.id, control, phaseState, distanceToNode)) return distanceToNode;
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
function mustYieldLeft(v: VehicleState, edge: Edge3D, nodeId: string, control: { groupA: string[]; groupB: string[]; greenDurationS: number }, phase: SignalPhaseState, distanceToNode: number): boolean {
  if (edge.displacedLeft) return false;
  const nextId = v.routeEdgeIds[v.routeIndex + 1];
  if (!nextId || edge.nextMoves.get(nextId) !== "left") return false;
  if (phase.timer > control.greenDurationS - LEFT_SNEAK_S) return false;
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

/** True when `kind` may never use `lane` of this edge (the reserved lane belongs to someone else). Ignores the turn exception. */
function isReservedAgainst(edge: Edge3D, lane: number, kind: VehicleKind): boolean {
  if (!edge.reservedLane || lane !== edge.lanes - 1) return false;
  if (isEmergencyKind(kind)) return false;
  return edge.reservedLane === "bus" ? kind !== "bus" : kind !== "bike";
}

/** As above, plus the real-world exception: right before a junction, anyone may use the lane if it is the only one that makes their turn. */
function laneForbidden(v: VehicleState, edge: Edge3D, lane: number): boolean {
  if (!isReservedAgainst(edge, lane, v.kind)) return false;
  if (edge.length - v.distanceAlongEdge < RESERVED_LANE_EXIT_FT) {
    const allowed = allowedLanesForNext(v, edge);
    if (allowed && !allowed.slice(0, edge.lanes - 1).some(Boolean)) return false;
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
    mphToFtps(effectiveSpeedLimitMph(edge)) * cruiseFactor(v) * weatherSpeedMult() * parkingSpeedMult(edge, v),
    curvatureSpeedCapFtps(edge, v.distanceAlongEdge),
    displacedLeftSpeedCapFtps(v, edge),
    v.maxSpeedFtps
  );
  const deltaV = v.speed - gapInfo.leaderSpeed;
  const params = {
    a: v.maxAccel,
    b: v.comfortBrake,
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
  return clamp(accel, -20, params.a);
}

/** The slowest a vehicle will hold on a climb it could otherwise not manage (about 10 mph). */
const CRAWL_SPEED_FTPS = mphToFtps(10);

// ---------------------------------------------------------------------------
// MOBIL lane changing (within the current edge only)
// ---------------------------------------------------------------------------

function pairAccel(followerV: VehicleState, followerDist: number, leader: VehicleState | null, edge: Edge3D): number {
  const v0 = Math.min(mphToFtps(effectiveSpeedLimitMph(edge)) * cruiseFactor(followerV) * weatherSpeedMult() * parkingSpeedMult(edge, followerV), followerV.maxSpeedFtps);
  let gap = NO_LEADER_GAP;
  let leaderSpeed = followerV.speed;
  if (leader) {
    gap = leader.distanceAlongEdge - leader.length - followerDist;
    leaderSpeed = leader.speed;
  }
  const params = {
    a: followerV.maxAccel,
    b: followerV.comfortBrake,
    s0: followerV.jamDistance,
    T: followerV.desiredHeadway * weatherHeadwayMult(),
    v0,
    delta: IDM_DEFAULTS.delta,
  };
  const gradeAccel = gradeAccelFtps2(
    edgeSinThetaAt(edge, followerDist),
    climbSensitivityFromWeightToPower(followerV.weightToPowerLbPerHp)
  );
  return clamp(idmAccel(followerV.speed, gap, followerV.speed - leaderSpeed, v0, params) + gradeAccel, -20, params.a);
}

function tryLaneChange(v: VehicleState, edge: Edge3D) {
  if (edge.lanes < 2) return;
  const yielding = v.yieldUntil > simTime;
  // A driver in a lane that has been closed ahead looks for a gap every tick rather than waiting out the usual pause.
  const leavingClosed = edge.closedLanes[v.laneIndex] && v.distanceAlongEdge >= gantryDistance(edge) - CLOSURE_WARNING_FT && !isEmergencyKind(v.kind);
  if (v.laneChangeCooldown > 0 && !yielding && !leavingClosed) {
    v.laneChangeCooldown -= 1;
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
  if (requiredDirection === 0 && edge.reservedLane && laneForbidden(v, edge, v.laneIndex) && v.laneIndex > 0) {
    requiredDirection = -1;
    mergeUrgency = 1;
  }
  // Buses and bikes head for the lane that was reserved for them, unless a left turn is coming up.
  if (requiredDirection === 0 && edge.reservedLane && v.laneIndex < edge.lanes - 1 && !isReservedAgainst(edge, edge.lanes - 1, v.kind)) {
    const nextId = v.routeEdgeIds[v.routeIndex + 1];
    const turnsLeft = nextId ? edge.nextMoves.get(nextId) === "left" : false;
    if (!turnsLeft || distanceToNode > 400) {
      requiredDirection = 1;
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

    const result = mobilEvaluate(inputs, MOBIL_DEFAULTS);
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
  for (const [entryId, demand] of demandByEntry) nextSpawnTimeByEntry.set(entryId, sampleExponentialInterarrival(demand));
}

function runDueEvents() {
  while (eventQueue.length > 0 && eventQueue[0].atS <= simTime) {
    const e = eventQueue.shift()!;
    if (e.kind === "breakdown") breakDownOneCar(e.durationS);
    else if (e.kind === "ambulance") ambPending.push(simTime);
    else if (e.kind === "crash") crashPending++;
    else if (e.kind === "stall") stallPending++;
    else if (e.kind === "debris") debrisPending++;
    else if (e.kind === "fender") fenderPending++;
    else if (e.kind === "weatherOn") scriptedWeather = e.weather;
    else if (e.kind === "weatherOff") scriptedWeather = null;
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
  if (!network) return;
  stepCounter++;
  simTime += dt;
  runDueEvents();

  updateSignalPhases(dt);
  if (crossings.size > 0) updateCrossings();
  // Crashes first: towing a wreck removes vehicles, which must happen before this tick's lane lists are built.
  updateCrashes();
  rebuildLaneOccupancy();
  updateAmbulanceDispatch();
  updateTransit();
  markAmbulanceYielders();
  rebuildNodeApproaches();

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
    tryLaneChange(v, edge);
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

    if (v.speed < STUCK_SPEED_THRESHOLD_FTPS) {
      v.stuckTimeS += dt;
    } else {
      v.stuckTimeS = 0;
    }
    if (v.stuckTimeS >= GRIDLOCK_DESPAWN_S && !isEmergencyKind(v.kind)) {
      toRemove.push(v.id);
      gridlockRemoved.add(v.id);
      gridlockPenaltyTotal++;
      continue;
    }

    const deltaDist = v.speed * dt;
    v.distanceAlongEdge += deltaDist;

    let currentEdge = edge;
    while (v.distanceAlongEdge >= currentEdge.length) {
      const overflow = v.distanceAlongEdge - currentEdge.length;
      v.routeIndex += 1;
      const nextEdgeId = v.routeEdgeIds[v.routeIndex];
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
      v.edgeId = nextEdgeId;
      v.laneIndex = mapLaneAcross(currentEdge, nextEdge, v.laneIndex);
      v.distanceAlongEdge = overflow;
      if (nextEdge.reservedLane && isReservedAgainst(nextEdge, v.laneIndex, v.kind) && v.laneIndex > 0) v.laneIndex -= 1;
      currentEdge = nextEdge;
    }
  }

  for (const id of toRemove) {
    const v = vehicles.get(id);
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

    speedSum += v.speed;
    i++;
  }
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
    stats = {
      contracts: computeContracts(),
      edgeSpeedRatios: computeEdgeSpeedRatios(),
      problemEdgeIds: Array.from(problemEdges),
      edgeTrafficStats: computeEdgeTrafficStatsList(),
      gridlockPenaltyTotal,
      gridlockMarkers,
      incidentMarkers,
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
    pedServedTotal,
    pedIncidentsTotal,
    pedCrossings: activeCrossingViews(),
    emergency: emergencyStats(),
    crashes: crashStats(),
    ambulances: ambulancePositions,
    incidents: incidentViews(),
    jakeBrakes: jakeBrakePositions.slice(),
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

ctx.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (msg.type !== "returnBuffers" && msg.type !== "setSpeedMultiplier" && msg.type !== "setMaxVehicles") snapshotDirty = true;
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
      else if (msg.kind === "debris") debrisPending++;
      else fenderPending++;
      break;
    case "dispatchWrecker": {
      const inc = incidents.find((i) => i.id === msg.incidentId);
      if (inc && !inc.wreckerRequested) inc.wreckerRequested = true;
      break;
    }
    case "setLeftTurnsYield":
      leftTurnsYield = msg.enabled;
      break;
    case "setTransit":
      transitLines = msg.lines;
      for (const id of Array.from(nextBusAt.keys())) if (!transitLines.some((l) => l.id === id)) nextBusAt.delete(id);
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
        else if (e.kind === "stall" || e.kind === "debris" || e.kind === "fender") eventQueue.push({ atS: e.atS, kind: e.kind });
        else if (e.kind === "weather") {
          eventQueue.push({ atS: e.atS, kind: "weatherOn", weather: e.weather });
          eventQueue.push({ atS: e.atS + e.durationS, kind: "weatherOff" });
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
        nextSpawnTimeByEntry.set(msg.edgeId, sampleExponentialInterarrival(msg.vehiclesPerHour));
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
};

// The headless harness sets this before importing the worker to get at the live state when diagnosing jams.
const debugSlot = (globalThis as { __simDebug?: Record<string, unknown> }).__simDebug;
if (debugSlot) {
  debugSlot.state = () => ({ vehicles, network, laneOccupancy, signalPhaseState, nodeApproaches, simTime, incidents, leftStats: () => ({ served: leftTurnsServed, waitS: leftTurnWaitTotalS }) });
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
