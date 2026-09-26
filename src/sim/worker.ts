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
import { buildNetwork, pickWeightedRoute } from "./network";
import {
  MAX_VEHICLES,
  SIM_DT,
  VEHICLE_HEIGHT_FT,
  VEHICLE_LENGTH_FT,
  mphToFtps,
  type Edge3D,
  type VehicleState,
  type WorkerInMessage,
  type WorkerOutMessage,
} from "./types";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Network + static lookups
// ---------------------------------------------------------------------------

const network = buildNetwork();
const edgesById = network.edgesById;

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

/** Per-edge, per-lane arrays of vehicle IDs, sorted ascending by distanceAlongEdge. Reused every tick (length reset, never reallocated) to avoid GC churn. */
const laneOccupancy = new Map<string, number[][]>();
for (const edge of network.edges) {
  const lanes: number[][] = [];
  for (let i = 0; i < edge.lanes; i++) lanes.push([]);
  laneOccupancy.set(edge.id, lanes);
}

const demandByEntry = new Map<string, number>();
const nextSpawnTimeByEntry = new Map<string, number>();
for (const entry of network.entries) {
  demandByEntry.set(entry.id, 900); // veh/h default
  nextSpawnTimeByEntry.set(entry.id, sampleExponentialInterarrival(900));
}

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

const COLOR_FREE = new THREE.Color(0x22c55e);
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
    totalDistanceFt: 0,
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
  return min + Math.random() * (max - min);
}

function randNormalish(mean: number, spread: number): number {
  // Sum of 3 uniforms approximates a bounded bell curve without the cost of Box-Muller.
  const u = (Math.random() + Math.random() + Math.random()) / 3;
  return mean + (u - 0.5) * 2 * spread;
}

function sampleExponentialInterarrival(vehiclesPerHour: number): number {
  if (vehiclesPerHour <= 0) return simTime + 1e9;
  const ratePerSecond = vehiclesPerHour / 3600;
  const u = Math.max(Math.random(), 1e-9);
  return simTime + -Math.log(1 - u) / ratePerSecond;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const MIN_SPAWN_CLEARANCE_FT = 55;

function trySpawn(entryId: string) {
  const entry = network.entries.find((e) => e.id === entryId);
  if (!entry) return;
  if (vehicles.size >= MAX_VEHICLES) return;

  const edge = edgesById.get(entry.edgeId);
  if (!edge) return;

  const laneOrder = Array.from({ length: edge.lanes }, (_, i) => i).sort(
    () => Math.random() - 0.5
  );

  const occupancy = laneOccupancy.get(edge.id);
  if (!occupancy) return;

  for (const laneIndex of laneOrder) {
    const laneArr = occupancy[laneIndex];
    const closest = laneArr.length > 0 ? vehicles.get(laneArr[0])?.distanceAlongEdge ?? Infinity : Infinity;
    if (closest >= MIN_SPAWN_CLEARANCE_FT) {
      spawnVehicleOnEntry(entry.id, edge, laneIndex);
      return;
    }
  }
  // No lane had clearance this attempt; will simply retry at the next Poisson draw.
}

function spawnVehicleOnEntry(entryId: string, edge: Edge3D, laneIndex: number) {
  const entry = network.entries.find((e) => e.id === entryId)!;
  const route = pickWeightedRoute(entry.routes);

  const v = acquireVehicle();
  v.id = nextVehicleId++;
  v.edgeId = route.edgeIds[0];
  v.laneIndex = laneIndex;
  v.distanceAlongEdge = 0;
  v.routeEdgeIds = route.edgeIds;
  v.routeIndex = 0;

  const isTruck = Math.random() < 0.08;
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
  v.totalDistanceFt = 0;
  v.spawnTime = simTime;

  vehicles.set(v.id, v);
  spawnedTotal++;
}

function updateSpawning() {
  for (const entry of network.entries) {
    const demand = demandByEntry.get(entry.id) ?? 0;
    let nextTime = nextSpawnTimeByEntry.get(entry.id) ?? simTime + 1e9;
    let guard = 0;
    while (simTime >= nextTime && guard < 8) {
      trySpawn(entry.id);
      nextTime = sampleExponentialInterarrival(demand);
      guard++;
    }
    nextSpawnTimeByEntry.set(entry.id, nextTime);
  }
}

// ---------------------------------------------------------------------------
// Lane occupancy rebuild
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
// Leader gap lookup (same-lane, crossing edge boundary via the vehicle's own route)
// ---------------------------------------------------------------------------

interface GapInfo {
  gap: number;
  leaderSpeed: number;
}

function findLeaderGapForVehicle(v: VehicleState, edge: Edge3D): GapInfo {
  const lanes = laneOccupancy.get(edge.id);
  if (!lanes) return { gap: NO_LEADER_GAP, leaderSpeed: v.speed };
  const laneArr = lanes[clamp(v.laneIndex, 0, lanes.length - 1)];
  const idx = laneArr.indexOf(v.id);
  if (idx >= 0 && idx < laneArr.length - 1) {
    const leader = vehicles.get(laneArr[idx + 1])!;
    return {
      gap: leader.distanceAlongEdge - leader.length - v.distanceAlongEdge,
      leaderSpeed: leader.speed,
    };
  }
  // No leader on this edge — peek across the boundary into the vehicle's own next route edge.
  const nextEdgeId = v.routeEdgeIds[v.routeIndex + 1];
  if (!nextEdgeId) return { gap: NO_LEADER_GAP, leaderSpeed: v.speed };
  const nextEdge = edgesById.get(nextEdgeId);
  if (!nextEdge) return { gap: NO_LEADER_GAP, leaderSpeed: v.speed };
  const nextLanes = laneOccupancy.get(nextEdgeId);
  if (!nextLanes) return { gap: NO_LEADER_GAP, leaderSpeed: v.speed };
  const targetLane = clamp(v.laneIndex, 0, nextEdge.lanes - 1);
  const nextLaneArr = nextLanes[targetLane];
  if (nextLaneArr.length === 0) return { gap: NO_LEADER_GAP, leaderSpeed: v.speed };
  const leader = vehicles.get(nextLaneArr[0])!;
  const remaining = edge.length - v.distanceAlongEdge;
  return {
    gap: remaining + leader.distanceAlongEdge - leader.length,
    leaderSpeed: leader.speed,
  };
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

function pairAccel(
  followerV: VehicleState,
  followerDist: number,
  leader: VehicleState | null,
  edge: Edge3D
): number {
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

  let bestLane = -1;
  let bestIncentive = -Infinity;

  for (const candidateLane of [v.laneIndex - 1, v.laneIndex + 1]) {
    if (candidateLane < 0 || candidateLane >= edge.lanes) continue;
    const candArr = lanes[candidateLane];

    // Find where the vehicle would insert among the candidate lane's occupants.
    let insertIdx = 0;
    while (
      insertIdx < candArr.length &&
      vehicles.get(candArr[insertIdx])!.distanceAlongEdge < v.distanceAlongEdge
    ) {
      insertIdx++;
    }
    const newLeader = insertIdx < candArr.length ? vehicles.get(candArr[insertIdx])! : null;
    const newFollower = insertIdx > 0 ? vehicles.get(candArr[insertIdx - 1])! : null;

    // Safety + physical feasibility: don't wedge into an occupied gap.
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

    const inputs: MobilInputs = {
      currentAccel: v.accel,
      targetLaneAccel,
      oldFollowerAccelBefore,
      oldFollowerAccelAfter,
      newFollowerAccelBefore,
      newFollowerAccelAfter,
      laneBiasDirection: candidateLane > v.laneIndex ? 1 : -1,
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
// Main physics step
// ---------------------------------------------------------------------------

const MAX_SPEED_FTPS = mphToFtps(90);

function step(dt: number) {
  simTime += dt;

  rebuildLaneOccupancy();

  // Pass 1: acceleration (IDM), based on the occupancy snapshot from the start of the tick.
  for (const v of vehicles.values()) {
    const edge = edgesById.get(v.edgeId);
    if (!edge) continue;
    const gapInfo = findLeaderGapForVehicle(v, edge);
    v.accel = idmAccelForVehicle(v, edge, gapInfo);
  }

  // Pass 2: MOBIL lane changes (mutates laneIndex only; positions unaffected this tick).
  for (const v of vehicles.values()) {
    const edge = edgesById.get(v.edgeId);
    if (!edge) continue;
    tryLaneChange(v, edge);
  }

  // Pass 3: integrate motion and handle edge transitions / despawn.
  const toRemove: number[] = [];
  for (const v of vehicles.values()) {
    const edge = edgesById.get(v.edgeId);
    if (!edge) continue;

    v.speed = clamp(v.speed + v.accel * dt, 0, MAX_SPEED_FTPS);
    const deltaDist = v.speed * dt;
    v.distanceAlongEdge += deltaDist;
    v.totalDistanceFt += deltaDist;

    let currentEdge = edge;
    while (v.distanceAlongEdge >= currentEdge.length) {
      const overflow = v.distanceAlongEdge - currentEdge.length;
      v.routeIndex += 1;
      const nextEdgeId = v.routeEdgeIds[v.routeIndex];
      if (!nextEdgeId) {
        toRemove.push(v.id);
        break;
      }
      const nextEdge = edgesById.get(nextEdgeId);
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

function writeSnapshot(buf: BufferSet): { activeCount: number; avgSpeedFtS: number } {
  let i = 0;
  let speedSum = 0;
  for (const v of vehicles.values()) {
    if (i >= MAX_VEHICLES) break;
    const edge = edgesById.get(v.edgeId);
    if (!edge) continue;

    const t = distanceToT(edge, v.distanceAlongEdge);
    laneCenterPointAt(edge, t, v.laneIndex, _tangent, _right, _pos);
    _pos.y += VEHICLE_HEIGHT_FT / 2;

    _quat.setFromUnitVectors(FORWARD_AXIS, _tangent);
    _scale.set(1, 1, v.length / VEHICLE_LENGTH_FT);
    _matrix.compose(_pos, _quat, _scale);
    _matrix.toArray(buf.matrices, i * 16);

    const speedLimitFtps = mphToFtps(edge.speedLimitMph);
    speedColorInto(v.speed / speedLimitFtps, _color);
    _color.toArray(buf.colors, i * 3);

    speedSum += v.speed;
    i++;
  }
  return { activeCount: i, avgSpeedFtS: i > 0 ? speedSum / i : 0 };
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
    case "setRunning":
      running = msg.running;
      lastWallTimeMs = performance.now();
      break;
    case "setSpeedMultiplier":
      speedMultiplier = msg.value;
      break;
    case "setDemand":
      demandByEntry.set(msg.entryId, msg.vehiclesPerHour);
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

const readyMessage: WorkerOutMessage = {
  type: "ready",
  entries: network.entries.map((e) => ({ id: e.id, label: e.label })),
};
ctx.postMessage(readyMessage);
