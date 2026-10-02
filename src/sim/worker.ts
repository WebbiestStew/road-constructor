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
import { distanceToT, laneCenterPointAt } from "./laneGeometry";
import { computeEdgeTrafficStats, type EdgeTrafficStats } from "./los";
import { assembleNetwork, computeRoute, patchEdge } from "./network";
import {
  MAX_VEHICLES,
  SIM_DT,
  VEHICLE_HEIGHT_FT,
  VEHICLE_LENGTH_FT,
  ftpsToMph,
  mphToFtps,
  type ContractStatus,
  type Edge3D,
  type EdgeSpeedRatio,
  type RoadNetwork,
  type TickStats,
  type VehicleKind,
  type VehicleState,
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
/** Scripted events not yet due, soonest first. A surge end is queued as its own entry when the surge starts. */
type QueuedEvent = { atS: number; kind: "breakdown"; durationS: number } | { atS: number; kind: "surge"; multiplier: number } | { atS: number; kind: "surgeEnd" };
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
    weightToPowerLbPerHp: 25,
    bodyColorR: 1,
    bodyColorG: 1,
    bodyColorB: 1,
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
  const ratePerSecond = (vehiclesPerHour * demandScale) / 3600;
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

  for (const [id, v] of vehicles) {
    if (!network.edgesById.has(v.edgeId)) {
      releaseVehicle(v);
      vehicles.delete(id);
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
  const isTruck = !isBus && !isBike && rng() < 0.15;
  v.isTruck = isTruck;
  v.kind = isBus ? "bus" : isBike ? "bike" : isTruck ? "truck" : "car";
  const palette = isBus ? BUS_PALETTE : isBike ? BIKE_PALETTE : isTruck ? TRUCK_PALETTE : SEDAN_PALETTE;
  _spawnColor.set(palette[Math.floor(rng() * palette.length)]);
  v.bodyColorR = _spawnColor.r;
  v.bodyColorG = _spawnColor.g;
  v.bodyColorB = _spawnColor.b;
  v.weightToPowerLbPerHp = isBus ? randRange(190, 240) : isBike ? 8 : isTruck ? randRange(260, 340) : randRange(18, 32);
  v.length = isBus ? randRange(38, 42) : isBike ? 6 : isTruck ? randRange(32, 42) : randRange(13, 19);
  v.maxAccel = isBus ? randRange(2.2, 2.9) : isBike ? randRange(1.2, 1.8) : isTruck ? randRange(2.6, 3.6) : randRange(3.8, 5.4);
  v.comfortBrake = isBus ? randRange(4.5, 5.5) : isBike ? 3.5 : isTruck ? randRange(5.5, 6.5) : randRange(5.8, 7.6);
  v.passengers = isBus ? Math.round(randRange(22, 42)) : isBike || isTruck ? 1 : 1.4;
  v.maxSpeedFtps = isBike ? mphToFtps(randRange(10, 13)) : Infinity;
  v.jamDistance = isBike ? randRange(2.5, 3.5) : randRange(5.5, 7.5);
  v.desiredHeadway = isBus || isTruck ? randRange(1.6, 2.0) : isBike ? randRange(0.8, 1.1) : randRange(1.1, 1.7);
  v.minGap = v.jamDistance;
  v.speedFactor = isBus ? randNormalish(0.92, 0.05) : randNormalish(1.0, 0.12);
  v.speed = Math.min(Math.min(v.speedFactor, 1.0) * mphToFtps(edge.speedLimitMph) * 0.85, v.maxSpeedFtps);
  v.accel = 0;
  v.laneChangeCooldown = randRange(0, 60);
  v.spawnTime = simTime;
  v.wrongLaneWaitS = 0;
  v.stuckTimeS = 0;
  v.frozenUntil = 0;

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

function rebuildLaneOccupancy() {
  for (const lanes of laneOccupancy.values()) {
    for (const arr of lanes) arr.length = 0;
  }
  for (const v of vehicles.values()) {
    const lanes = laneOccupancy.get(v.edgeId);
    if (!lanes) continue;
    const laneArr = lanes[clamp(v.laneIndex, 0, lanes.length - 1)];
    laneArr.push(v.id);
  }
  for (const lanes of laneOccupancy.values()) {
    for (const arr of lanes) {
      arr.sort((a, b) => vehicles.get(a)!.distanceAlongEdge - vehicles.get(b)!.distanceAlongEdge);
    }
  }
}

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
    arr.push({ edgeId: edge.id, priority: edge.priority, distanceToNode });
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

/** Returns the distance (ft) at which a vehicle must stop for a junction it cannot yet enter, or null if clear. */
function computeVirtualStopDistance(v: VehicleState, edge: Edge3D): number | null {
  if (!network) return null;
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

// ---------------------------------------------------------------------------
// Leader gap lookup (same-lane, crossing edge boundary via the vehicle's own route, and junction stop lines)
// ---------------------------------------------------------------------------

interface GapInfo {
  gap: number;
  leaderSpeed: number;
}

/** Lanes of `edge` that may take the vehicle's next route edge (index 0 = leftmost), or null if any lane may. */
function allowedLanesForNext(v: VehicleState, edge: Edge3D): boolean[] | null {
  if (!edge.laneAllowed) return null;
  const nextRouteEdgeId = v.routeEdgeIds[v.routeIndex + 1];
  return nextRouteEdgeId ? (edge.laneAllowed.get(nextRouteEdgeId) ?? null) : null;
}

/** How close to the end of a road a car may slip into a reserved lane if that is the only lane that can make its turn. */
const RESERVED_LANE_EXIT_FT = 150;

/** True when `kind` may never use `lane` of this edge (the reserved lane belongs to someone else). Ignores the turn exception. */
function isReservedAgainst(edge: Edge3D, lane: number, kind: VehicleKind): boolean {
  if (!edge.reservedLane || lane !== edge.lanes - 1) return false;
  if (kind === "ambulance") return false;
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
        const targetLane = clamp(v.laneIndex, 0, nextEdge.lanes - 1);
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
  edge.spline.getTangentAt(t0, _curveTangentA);
  edge.spline.getTangentAt(t1, _curveTangentB);
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
  edge.spline.getTangentAt(t, _gradeTangent);
  return _gradeTangent.y;
}

function idmAccelForVehicle(v: VehicleState, edge: Edge3D, gapInfo: GapInfo): number {
  const v0 = Math.min(
    mphToFtps(edge.speedLimitMph) * Math.min(v.speedFactor, 1.05),
    curvatureSpeedCapFtps(edge, v.distanceAlongEdge),
    v.maxSpeedFtps
  );
  const deltaV = v.speed - gapInfo.leaderSpeed;
  const params = {
    a: v.maxAccel,
    b: v.comfortBrake,
    s0: v.jamDistance,
    T: v.desiredHeadway,
    v0,
    delta: IDM_DEFAULTS.delta,
  };
  const gradeAccel = gradeAccelFtps2(
    edgeSinThetaAt(edge, v.distanceAlongEdge),
    climbSensitivityFromWeightToPower(v.weightToPowerLbPerHp)
  );
  return clamp(idmAccel(v.speed, gapInfo.gap, deltaV, v0, params) + gradeAccel, -20, params.a);
}

// ---------------------------------------------------------------------------
// MOBIL lane changing (within the current edge only)
// ---------------------------------------------------------------------------

function pairAccel(followerV: VehicleState, followerDist: number, leader: VehicleState | null, edge: Edge3D): number {
  const v0 = Math.min(mphToFtps(edge.speedLimitMph) * Math.min(followerV.speedFactor, 1.05), followerV.maxSpeedFtps);
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
    T: followerV.desiredHeadway,
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
  if (v.laneChangeCooldown > 0) {
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
  const followerV0 = mphToFtps(edge.speedLimitMph) * Math.min(v.speedFactor, 1.05);
  const truckOvertakeBias =
    !v.isTruck && v.kind !== "bike" && oldLeader && (oldLeader.isTruck || oldLeader.kind === "bike") && oldLeader.speed < followerV0 * 0.6 ? 6 : 0;

  let bestLane = -1;
  let bestIncentive = -Infinity;

  for (const candidateLane of [v.laneIndex - 1, v.laneIndex + 1]) {
    if (candidateLane < 0 || candidateLane >= edge.lanes) continue;
    if (laneForbidden(v, edge, candidateLane)) continue;
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
      (requiredDirection !== 0 && candidateDirection === requiredDirection ? mergeUrgency * 8 : 0) +
      truckOvertakeBias;

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
  simTime += dt;
  runDueEvents();

  updateSignalPhases(dt);
  rebuildLaneOccupancy();
  rebuildNodeApproaches();

  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;
    updateWrongLaneTimer(v, edge, dt);
    const gapInfo = findLeaderGapForVehicle(v, edge);
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
    if (v.stuckTimeS >= GRIDLOCK_DESPAWN_S) {
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
      v.edgeId = nextEdgeId;
      v.laneIndex = clamp(v.laneIndex, 0, nextEdge.lanes - 1);
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
      if (!gridlockRemoved.has(id)) {
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
): { activeCount: number; avgSpeedFtS: number; gridlockMarkers: [number, number, number][]; incidentMarkers: [number, number, number][] } {
  if (!network) return { activeCount: 0, avgSpeedFtS: 0, gridlockMarkers: [], incidentMarkers: [] };
  if (collectStats) {
    edgeSpeedRatioSum.clear();
    edgeSpeedRatioCount.clear();
    edgeSpeedSumMph.clear();
  }
  const gridlockMarkers: [number, number, number][] = [];
  const incidentMarkers: [number, number, number][] = [];
  let i = 0;
  let speedSum = 0;
  for (const v of vehicles.values()) {
    if (i >= MAX_VEHICLES) break;
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;

    // Trucks get a taller, slightly wider box on top of their already-longer
    // length, so an 18-wheeler reads as a distinct bulkier silhouette next
    // to a sedan using nothing but the one shared box geometry.
    const widthScale = v.kind === "bus" ? 1.25 : v.kind === "bike" ? 0.32 : v.isTruck ? 1.15 : 1;
    const heightScale = v.kind === "bus" ? 1.85 : v.kind === "bike" ? 0.75 : v.isTruck ? 1.55 : 1;

    const t = distanceToT(edge, v.distanceAlongEdge);
    laneCenterPointAt(edge, t, v.laneIndex, _tangent, _right, _pos);
    // The box's local origin is its center, so its footprint sits at ground
    // level only if we lift it by half of its *scaled* height — using the
    // unscaled height here would leave taller (truck) boxes sunk into the
    // pavement by the difference.
    _pos.y += (VEHICLE_HEIGHT_FT * heightScale) / 2;

    const broken = v.frozenUntil > simTime;
    if (broken) {
      incidentMarkers.push([_pos.x, _pos.y, _pos.z]);
    } else if (v.stuckTimeS >= GRIDLOCK_WARNING_S) {
      gridlockMarkers.push([_pos.x, _pos.y, _pos.z]);
    }

    _quat.setFromUnitVectors(FORWARD_AXIS, _tangent);
    _scale.set(widthScale, heightScale, v.length / VEHICLE_LENGTH_FT);
    _matrix.compose(_pos, _quat, _scale);
    _matrix.toArray(buf.matrices, i * 16);

    const speedLimitFtps = mphToFtps(edge.speedLimitMph);
    const ratio = v.speed / speedLimitFtps;
    if (broken) {
      // Hazard red, whatever the paint or heatmap would say.
      buf.colors[i * 3] = 1;
      buf.colors[i * 3 + 1] = 0.12;
      buf.colors[i * 3 + 2] = 0.12;
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
  return { activeCount: i, avgSpeedFtS: i > 0 ? speedSum / i : 0, gridlockMarkers, incidentMarkers };
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
  const { activeCount, avgSpeedFtS, gridlockMarkers, incidentMarkers } = writeSnapshot(buf, withStats);
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
    case "scheduleEvents": {
      eventQueue = [];
      for (const e of msg.events) {
        eventQueue.push(e.kind === "breakdown" ? { atS: e.atS, kind: "breakdown", durationS: e.durationS } : { atS: e.atS, kind: "surge", multiplier: e.multiplier });
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

lastWallTimeMs = performance.now();
setInterval(loopTick, LOOP_INTERVAL_MS);

const readyMessage: WorkerOutMessage = { type: "ready" };
ctx.postMessage(readyMessage);
