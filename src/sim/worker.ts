/// <reference lib="webworker" />

import * as THREE from "three";
import {
  IDM_DEFAULTS,
  MOBIL_DEFAULTS,
  NO_LEADER_GAP,
  clamp,
  idmAccel,
  mobilEvaluate,
  type MobilInputs,
} from "./idm";
import { distanceToT, laneCenterPointAt } from "./laneGeometry";
import { assembleNetwork, computeRoute } from "./network";
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
let nextVehicleId = 1;
let spawnedTotal = 0;
let accumulator = 0;
let lastWallTimeMs = 0;

const vehicles = new Map<number, VehicleState>();
const vehiclePool: VehicleState[] = [];
const despawnTimestamps: number[] = [];

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

// Blue -> amber -> red (never green) so free-flow vs. stopped traffic reads
// correctly for red-green colorblind players, who lose the green/red contrast
// but keep blue fully distinct.
const COLOR_FREE = new THREE.Color(0x3b82f6);
const COLOR_SLOW = new THREE.Color(0xeab308);
const COLOR_STOP = new THREE.Color(0xef4444);

// ---------------------------------------------------------------------------
// Double-buffered transfer pool
// ---------------------------------------------------------------------------

interface BufferSet {
  matrices: Float32Array;
  colors: Float32Array;
}

function createBufferSet(): BufferSet {
  return {
    matrices: new Float32Array(MAX_VEHICLES * 16),
    colors: new Float32Array(MAX_VEHICLES * 3),
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
    desiredSpeed: 0,
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
  const ratePerSecond = vehiclesPerHour / 3600;
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

  for (const [id, v] of vehicles) {
    if (!network.edgesById.has(v.edgeId)) {
      releaseVehicle(v);
      vehicles.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const MIN_SPAWN_CLEARANCE_FT = 55;

function trySpawn(entryEdgeId: string) {
  if (!network) return;
  if (vehicles.size >= MAX_VEHICLES) return;

  const edge = network.edgesById.get(entryEdgeId);
  if (!edge || edge.zone?.type !== "entry") return;

  const destinations = network.edges.filter((e) => e.zone?.type === "destination" && e.id !== entryEdgeId);
  if (destinations.length === 0) return;

  const destination = destinations[Math.floor(rng() * destinations.length)];
  const route = computeRoute(network, entryEdgeId, destination.id);
  if (!route || route.length === 0) return;

  const occupancy = laneOccupancy.get(edge.id);
  if (!occupancy) return;

  const laneOrder = Array.from({ length: edge.lanes }, (_, i) => i).sort(() => rng() - 0.5);
  for (const laneIndex of laneOrder) {
    const laneArr = occupancy[laneIndex];
    const closest = laneArr.length > 0 ? vehicles.get(laneArr[0])?.distanceAlongEdge ?? Infinity : Infinity;
    if (closest >= MIN_SPAWN_CLEARANCE_FT) {
      spawnVehicle(edge, laneIndex, route, destination.id);
      return;
    }
  }
}

function spawnVehicle(edge: Edge3D, laneIndex: number, route: string[], destinationEdgeId: string) {
  const v = acquireVehicle();
  v.id = nextVehicleId++;
  v.edgeId = edge.id;
  v.laneIndex = laneIndex;
  v.distanceAlongEdge = 0;
  v.routeEdgeIds = route;
  v.routeIndex = 0;
  v.destinationEdgeId = destinationEdgeId;

  const isTruck = rng() < 0.08;
  v.length = isTruck ? randRange(32, 42) : randRange(13, 19);
  v.maxAccel = isTruck ? randRange(2.6, 3.6) : randRange(3.8, 5.4);
  v.comfortBrake = isTruck ? randRange(5.5, 6.5) : randRange(5.8, 7.6);
  v.jamDistance = randRange(5.5, 7.5);
  v.desiredHeadway = isTruck ? randRange(1.6, 2.0) : randRange(1.1, 1.7);
  v.minGap = v.jamDistance;
  v.desiredSpeed = mphToFtps(edge.speedLimitMph) * randNormalish(1.0, 0.12);
  v.speed = Math.min(v.desiredSpeed, mphToFtps(edge.speedLimitMph)) * 0.85;
  v.accel = 0;
  v.laneChangeCooldown = randRange(0, 60);
  v.spawnTime = simTime;

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

function updateSignalPhases(dt: number) {
  if (!network) return;
  for (const [nodeId, node] of network.nodesById) {
    if (node.control?.type !== "signal") continue;
    const ctrl = node.control;
    let state = signalPhaseState.get(nodeId);
    if (!state) {
      state = { phase: "A", timer: 0, nextPhase: "B" };
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

/** Returns the distance (ft) at which a vehicle must stop for a junction it cannot yet enter, or null if clear. */
function computeVirtualStopDistance(v: VehicleState, edge: Edge3D): number | null {
  if (!network) return null;
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

  return result;
}

function idmAccelForVehicle(v: VehicleState, edge: Edge3D, gapInfo: GapInfo): number {
  const v0 = Math.min(v.desiredSpeed, mphToFtps(edge.speedLimitMph) * 1.05);
  const deltaV = v.speed - gapInfo.leaderSpeed;
  const params = {
    a: v.maxAccel,
    b: v.comfortBrake,
    s0: v.jamDistance,
    T: v.desiredHeadway,
    v0,
    delta: IDM_DEFAULTS.delta,
  };
  return clamp(idmAccel(v.speed, gapInfo.gap, deltaV, v0, params), -20, params.a);
}

// ---------------------------------------------------------------------------
// MOBIL lane changing (within the current edge only)
// ---------------------------------------------------------------------------

function pairAccel(followerV: VehicleState, followerDist: number, leader: VehicleState | null, edge: Edge3D): number {
  const v0 = Math.min(followerV.desiredSpeed, mphToFtps(edge.speedLimitMph) * 1.05);
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
  return clamp(idmAccel(followerV.speed, gap, followerV.speed - leaderSpeed, v0, params), -20, params.a);
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
  if (edge.divergeLaneRanges) {
    const nextRouteEdgeId = v.routeEdgeIds[v.routeIndex + 1];
    const range = nextRouteEdgeId ? edge.divergeLaneRanges.get(nextRouteEdgeId) : undefined;
    if (range && (v.laneIndex < range[0] || v.laneIndex > range[1])) {
      requiredDirection = v.laneIndex < range[0] ? 1 : -1;
      const distanceToNode = edge.length - v.distanceAlongEdge;
      mergeUrgency = clamp(1 - distanceToNode / 500, 0, 1);
    }
  }

  let bestLane = -1;
  let bestIncentive = -Infinity;

  for (const candidateLane of [v.laneIndex - 1, v.laneIndex + 1]) {
    if (candidateLane < 0 || candidateLane >= edge.lanes) continue;
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
    const extraBias = requiredDirection !== 0 && candidateDirection === requiredDirection ? mergeUrgency * 8 : 0;

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

function step(dt: number) {
  if (!network) return;
  simTime += dt;

  updateSignalPhases(dt);
  rebuildLaneOccupancy();
  rebuildNodeApproaches();

  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;
    const gapInfo = findLeaderGapForVehicle(v, edge);
    v.accel = idmAccelForVehicle(v, edge, gapInfo);
  }

  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;
    tryLaneChange(v, edge);
  }

  const toRemove: number[] = [];
  for (const v of vehicles.values()) {
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;

    v.speed = clamp(v.speed + v.accel * dt, 0, MAX_SPEED_FTPS);
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
      currentEdge = nextEdge;
    }
  }

  for (const id of toRemove) {
    const v = vehicles.get(id);
    if (v) {
      despawnTimestamps.push(simTime);
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

function speedColorInto(ratio: number, out: THREE.Color) {
  const r = clamp(ratio, 0, 1.2);
  if (r >= 0.75) {
    out.copy(COLOR_FREE);
  } else if (r <= 0.2) {
    out.copy(COLOR_STOP);
  } else if (r <= 0.5) {
    out.lerpColors(COLOR_STOP, COLOR_SLOW, (r - 0.2) / 0.3);
  } else {
    out.lerpColors(COLOR_SLOW, COLOR_FREE, (r - 0.5) / 0.25);
  }
}

const edgeSpeedRatioSum = new Map<string, number>();
const edgeSpeedRatioCount = new Map<string, number>();

function writeSnapshot(buf: BufferSet): { activeCount: number; avgSpeedFtS: number } {
  if (!network) return { activeCount: 0, avgSpeedFtS: 0 };
  edgeSpeedRatioSum.clear();
  edgeSpeedRatioCount.clear();
  let i = 0;
  let speedSum = 0;
  for (const v of vehicles.values()) {
    if (i >= MAX_VEHICLES) break;
    const edge = network.edgesById.get(v.edgeId);
    if (!edge) continue;

    const t = distanceToT(edge, v.distanceAlongEdge);
    laneCenterPointAt(edge, t, v.laneIndex, _tangent, _right, _pos);
    _pos.y += VEHICLE_HEIGHT_FT / 2;

    _quat.setFromUnitVectors(FORWARD_AXIS, _tangent);
    _scale.set(1, 1, v.length / VEHICLE_LENGTH_FT);
    _matrix.compose(_pos, _quat, _scale);
    _matrix.toArray(buf.matrices, i * 16);

    const speedLimitFtps = mphToFtps(edge.speedLimitMph);
    const ratio = v.speed / speedLimitFtps;
    speedColorInto(ratio, _color);
    _color.toArray(buf.colors, i * 3);

    edgeSpeedRatioSum.set(edge.id, (edgeSpeedRatioSum.get(edge.id) ?? 0) + ratio);
    edgeSpeedRatioCount.set(edge.id, (edgeSpeedRatioCount.get(edge.id) ?? 0) + 1);

    speedSum += v.speed;
    i++;
  }
  return { activeCount: i, avgSpeedFtS: i > 0 ? speedSum / i : 0 };
}

function computeEdgeSpeedRatios(): EdgeSpeedRatio[] {
  const result: EdgeSpeedRatio[] = [];
  for (const [edgeId, sum] of edgeSpeedRatioSum) {
    const count = edgeSpeedRatioCount.get(edgeId) ?? 1;
    result.push([edgeId, sum / count]);
  }
  return result;
}

function postSnapshot() {
  const buf = acquireBufferSet();
  const { activeCount, avgSpeedFtS } = writeSnapshot(buf);
  const matricesBuffer = buf.matrices.buffer as ArrayBuffer;
  const colorsBuffer = buf.colors.buffer as ArrayBuffer;
  const message: WorkerOutMessage = {
    type: "tick",
    matrices: matricesBuffer,
    colors: colorsBuffer,
    activeCount,
    simTime,
    avgSpeedFtS,
    throughputLastMinute: despawnTimestamps.length,
    spawnedTotal,
    contracts: computeContracts(),
    edgeSpeedRatios: computeEdgeSpeedRatios(),
  };
  ctx.postMessage(message, [matricesBuffer, colorsBuffer]);
}

// ---------------------------------------------------------------------------
// Fixed-timestep loop, decoupled from render cadence
// ---------------------------------------------------------------------------

const LOOP_INTERVAL_MS = 1000 / 60;
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

  postSnapshot();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

ctx.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  switch (msg.type) {
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
    case "setDemand":
      demandByEntry.set(msg.edgeId, msg.vehiclesPerHour);
      if (!nextSpawnTimeByEntry.has(msg.edgeId)) {
        nextSpawnTimeByEntry.set(msg.edgeId, sampleExponentialInterarrival(msg.vehiclesPerHour));
      }
      break;
    case "returnBuffers":
      bufferPool.push({
        matrices: new Float32Array(msg.matrices),
        colors: new Float32Array(msg.colors),
      });
      break;
  }
};

lastWallTimeMs = performance.now();
setInterval(loopTick, LOOP_INTERVAL_MS);

const readyMessage: WorkerOutMessage = { type: "ready" };
ctx.postMessage(readyMessage);
