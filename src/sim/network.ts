import * as THREE from "three";
import {
  ROAD_CLASSES,
  ROUNDABOUT_PRIORITY,
  TEXAS_TURNAROUND_MIN_RADIUS_FT,
  TEXAS_TURNAROUND_PRIORITY,
  TEXAS_TURNAROUND_SEARCH_RADIUS_FT,
} from "./roadClasses";
import { mphToFtps } from "./types";
import type {
  Edge3D,
  EdgeSpec,
  NetworkSnapshot,
  NodeSpec,
  RoadNetwork,
} from "./types";

const ELEVATION_SAMPLE_STEPS = 16;
const ELEVATION_THRESHOLD_FT = 1;

/** A brand-new, empty buildable network — the sandbox starting state. */
export function createEmptyNetworkSnapshot(): NetworkSnapshot {
  return { nodes: [], edges: [] };
}

/** Points a plain node-to-node ramp is subdivided into so its elevation can ease in/out instead of jumping to a new grade in one straight line. */
const VERTICAL_CURVE_STEPS = 6;
/** Elevation delta (ft) below which a straight segment reads as flat enough that a vertical curve would be pointless. */
const VERTICAL_CURVE_THRESHOLD_FT = 0.5;

function buildSpline(spec: EdgeSpec, nodesById: Map<string, NodeSpec>): THREE.CatmullRomCurve3 {
  const fromNode = nodesById.get(spec.fromNodeId);
  const toNode = nodesById.get(spec.toNodeId);
  if (!fromNode || !toNode) {
    throw new Error(`Edge ${spec.id} references unknown node`);
  }
  const from = fromNode.position;
  const to = toNode.position;

  // A plain node-to-node ramp with a real elevation change gets a smooth
  // (ease-in/out) vertical curve instead of one straight linear grade line,
  // so the deck doesn't kink where it meets a flat approach at either end —
  // the "sharp kink" a real vertical curve (PVC/PVT) is designed to remove.
  // Edges with player-placed interior points keep their authored shape.
  if (spec.interiorPoints.length === 0 && Math.abs(to[1] - from[1]) > VERTICAL_CURVE_THRESHOLD_FT) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= VERTICAL_CURVE_STEPS; i++) {
      const t = i / VERTICAL_CURVE_STEPS;
      const eased = t * t * (3 - 2 * t); // smoothstep: zero slope at both ends
      points.push(
        new THREE.Vector3(
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * eased,
          from[2] + (to[2] - from[2]) * t
        )
      );
    }
    return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
  }

  const points: THREE.Vector3[] = [new THREE.Vector3(...from)];
  for (const p of spec.interiorPoints) points.push(new THREE.Vector3(...p));
  points.push(new THREE.Vector3(...to));
  return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
}

function computeIsElevated(curve: THREE.CatmullRomCurve3): boolean {
  const p = new THREE.Vector3();
  for (let i = 0; i <= ELEVATION_SAMPLE_STEPS; i++) {
    curve.getPointAt(i / ELEVATION_SAMPLE_STEPS, p);
    if (p.y > ELEVATION_THRESHOLD_FT) return true;
  }
  return false;
}

/**
 * Pure function converting the editable NetworkSnapshot into the runtime
 * RoadNetwork (real splines, derived adjacency). Called independently by
 * both the main thread (for rendering) and the simulation worker (for
 * routing/physics) — the two never need to share live THREE objects across
 * the postMessage boundary, only the plain snapshot data.
 */
export function assembleNetwork(snapshot: NetworkSnapshot): RoadNetwork {
  const nodesById = new Map(snapshot.nodes.map((n) => [n.id, n]));

  const edges: Edge3D[] = snapshot.edges.map((spec) => {
    const spline = buildSpline(spec, nodesById);
    const length = spline.getLength();
    const roadClass = ROAD_CLASSES[spec.roadClassId];
    return {
      id: spec.id,
      fromNodeId: spec.fromNodeId,
      toNodeId: spec.toNodeId,
      spline,
      lanes: spec.lanes,
      laneWidthFt: spec.laneWidthFt,
      speedLimitMph: spec.speedLimitMph,
      length,
      roadClassId: spec.roadClassId,
      elevationLevelId: spec.elevationLevelId,
      priority: spec.isRoundaboutRing
        ? ROUNDABOUT_PRIORITY
        : spec.isTexasTurnaround
          ? TEXAS_TURNAROUND_PRIORITY
          : roadClass.priority,
      isFreeway: spec.roadClassId === "highway" || spec.roadClassId === "motorway",
      isElevated: computeIsElevated(spline),
      zone: spec.zone,
      isRoundaboutRing: spec.isRoundaboutRing ?? false,
      isTexasTurnaround: spec.isTexasTurnaround ?? false,
      nextEdgeIds: [],
      divergeLaneRanges: null,
      laneTurnBias: new Array(spec.lanes).fill(0),
    };
  });

  const edgesById = new Map(edges.map((e) => [e.id, e]));
  for (const edge of edges) {
    edge.nextEdgeIds = edges
      .filter((e2) => e2.fromNodeId === edge.toNodeId)
      .map((e2) => e2.id);
  }

  for (const edge of edges) {
    assignDivergeLanes(edge, edgesById);
  }

  return { nodesById, edges, edgesById };
}

// ---------------------------------------------------------------------------
// A one-slot memoization cache for assembleNetwork, keyed by the exact
// `nodes`/`edges` array references. RoadNetworkMesh, InfoPanel's live edge
// and junction inspectors, and JointClackDetector each independently call
// assembleNetwork off the same editor-store arrays, which — for anything
// past a small network — is real, duplicated O(edges^2) work (the diverge-
// lane assignment pass) done up to four times per store update instead of
// once. Since the store's `nodes`/`edges` are only ever replaced wholesale
// (never mutated in place), a same-reference check is a safe, exact cache
// hit test — no risk of serving stale data.
// ---------------------------------------------------------------------------
let cachedNodes: NodeSpec[] | null = null;
let cachedEdges: EdgeSpec[] | null = null;
let cachedNetwork: RoadNetwork | null = null;

/** Same result as `assembleNetwork({ nodes, edges })`, but reuses the last computed network when both array references are unchanged since the last call — see the module-level comment above. */
export function assembleNetworkCached(nodes: NodeSpec[], edges: EdgeSpec[]): RoadNetwork {
  if (cachedNetwork && cachedNodes === nodes && cachedEdges === edges) {
    return cachedNetwork;
  }
  cachedNodes = nodes;
  cachedEdges = edges;
  cachedNetwork = assembleNetwork({ nodes, edges });
  return cachedNetwork;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * When an edge has 2+ lanes and diverges into 2+ distinct next edges, splits
 * its lanes into contiguous left-to-right ranges — one per next edge, ordered
 * by exit heading — so vehicles have a specific lane (or lanes) to merge into
 * ahead of the diverge, mirroring how real multi-lane roads sign turn/exit lanes.
 */
function assignDivergeLanes(edge: Edge3D, edgesById: Map<string, Edge3D>): void {
  if (edge.lanes < 2 || edge.nextEdgeIds.length < 2) return;
  const nextEdges = edge.nextEdgeIds
    .map((id) => edgesById.get(id))
    .filter((e): e is Edge3D => !!e);
  if (nextEdges.length < 2) return;

  const tangentEnd = edge.spline.getTangentAt(1);
  const rightEnd = new THREE.Vector3().crossVectors(tangentEnd, UP).normalize();

  const scored = nextEdges
    .map((ne) => ({ id: ne.id, score: ne.spline.getTangentAt(0).dot(rightEnd) }))
    .sort((a, b) => a.score - b.score);

  const lanes = edge.lanes;
  const count = scored.length;
  const base = Math.floor(lanes / count);
  let remainder = lanes - base * count;

  const ranges = new Map<string, [number, number]>();
  let cursor = 0;
  for (const s of scored) {
    let laneCount = base;
    if (remainder > 0) {
      laneCount += 1;
      remainder -= 1;
    }
    if (laneCount < 1) laneCount = 1;
    const start = cursor;
    const end = Math.min(lanes - 1, cursor + laneCount - 1);
    ranges.set(s.id, [start, end]);
    for (let i = start; i <= end; i++) {
      edge.laneTurnBias[i] = Math.max(-1, Math.min(1, s.score * 2));
    }
    cursor = end + 1;
  }
  edge.divergeLaneRanges = ranges;
}

/**
 * Shortest-route search (Dijkstra, weighted by estimated travel time) over
 * the edge-adjacency graph. Small networks (hundreds of edges), so a plain
 * O(V^2) scan is simpler and plenty fast — no heap needed.
 */
export function computeRoute(
  network: RoadNetwork,
  fromEdgeId: string,
  toEdgeId: string
): string[] | null {
  if (fromEdgeId === toEdgeId) return [fromEdgeId];

  const startEdge = network.edgesById.get(fromEdgeId);
  if (!startEdge || !network.edgesById.has(toEdgeId)) return null;

  const travelTime = (e: Edge3D) => e.length / Math.max(mphToFtps(e.speedLimitMph), 1);

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  dist.set(fromEdgeId, travelTime(startEdge));

  for (;;) {
    let currentId: string | null = null;
    let currentDist = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < currentDist) {
        currentDist = d;
        currentId = id;
      }
    }
    if (currentId === null || currentId === toEdgeId) break;
    visited.add(currentId);

    const currentEdge = network.edgesById.get(currentId);
    if (!currentEdge) continue;

    for (const nextId of currentEdge.nextEdgeIds) {
      if (visited.has(nextId)) continue;
      const nextEdge = network.edgesById.get(nextId);
      if (!nextEdge) continue;
      const candidate = currentDist + travelTime(nextEdge);
      if (candidate < (dist.get(nextId) ?? Infinity)) {
        dist.set(nextId, candidate);
        prev.set(nextId, currentId);
      }
    }
  }

  if (!dist.has(toEdgeId)) return null;

  const path: string[] = [toEdgeId];
  let cursor = toEdgeId;
  while (cursor !== fromEdgeId) {
    const p = prev.get(cursor);
    if (!p) return null;
    path.push(p);
    cursor = p;
  }
  path.reverse();
  return path;
}

export interface EdgePointHit {
  t: number;
  point: THREE.Vector3;
  distSq: number;
}

/**
 * Finds the closest point on an edge's centerline to a given world point via
 * coarse-then-fine sampling. One-off editor interaction (e.g. clicking a
 * road to anchor a Texas turnaround) — never called in the simulation's
 * per-tick hot path, so a few dozen curve samples is a fine cost.
 */
export function findClosestPointOnEdge(edge: Edge3D, point: THREE.Vector3, coarseSteps = 40): EdgePointHit {
  let bestT = 0;
  let bestDistSq = Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i <= coarseSteps; i++) {
    const t = i / coarseSteps;
    edge.spline.getPointAt(t, p);
    const d = p.distanceToSquared(point);
    if (d < bestDistSq) {
      bestDistSq = d;
      bestT = t;
    }
  }

  let lo = Math.max(0, bestT - 1 / coarseSteps);
  let hi = Math.min(1, bestT + 1 / coarseSteps);
  const fineSteps = 10;
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i <= fineSteps; i++) {
      const t = lo + ((hi - lo) * i) / fineSteps;
      edge.spline.getPointAt(t, p);
      const d = p.distanceToSquared(point);
      if (d < bestDistSq) {
        bestDistSq = d;
        bestT = t;
      }
    }
    const newSpan = (hi - lo) / fineSteps;
    lo = Math.max(0, bestT - newSpan);
    hi = Math.min(1, bestT + newSpan);
  }

  const point3 = new THREE.Vector3();
  edge.spline.getPointAt(bestT, point3);
  return { t: bestT, point: point3, distSq: bestDistSq };
}

export interface TexasTurnaroundPlan {
  /** The opposing (roughly anti-parallel) edge the loop merges back into. */
  targetEdgeId: string;
  nodeAPoint: [number, number, number];
  nodeBPoint: [number, number, number];
  controlPoint1: [number, number, number];
  controlPoint2: [number, number, number];
  lengthFt: number;
}

const _turnaroundUp = new THREE.Vector3(0, 1, 0);

/**
 * Pure geometry planner shared by the live hover preview and the actual
 * Texas turnaround build action: given a clicked/hovered edge and an anchor
 * point on it, finds the nearest opposing (anti-parallel) frontage edge
 * within range and computes the looped slip-lane path connecting them.
 * Returns null if no suitable opposing edge exists nearby — never mutates
 * anything.
 */
export function planTexasTurnaround(
  network: RoadNetwork,
  edgeId: string,
  anchorPoint: THREE.Vector3
): TexasTurnaroundPlan | null {
  const edgeA = network.edgesById.get(edgeId);
  if (!edgeA) return null;

  const hitA = findClosestPointOnEdge(edgeA, anchorPoint);
  const dirA = edgeA.spline.getTangentAt(hitA.t);
  const right = new THREE.Vector3().crossVectors(dirA, _turnaroundUp).normalize();

  let best: { edgeId: string; point: THREE.Vector3; dir: THREE.Vector3; distSq: number } | null = null;
  for (const candidate of network.edges) {
    if (candidate.id === edgeA.id) continue;
    if (candidate.isRoundaboutRing || candidate.isTexasTurnaround) continue;
    if (
      candidate.fromNodeId === edgeA.fromNodeId ||
      candidate.fromNodeId === edgeA.toNodeId ||
      candidate.toNodeId === edgeA.fromNodeId ||
      candidate.toNodeId === edgeA.toNodeId
    ) {
      continue; // already meets edge A at a shared node — not a separate frontage road
    }
    const hit = findClosestPointOnEdge(candidate, hitA.point);
    if (hit.distSq > TEXAS_TURNAROUND_SEARCH_RADIUS_FT * TEXAS_TURNAROUND_SEARCH_RADIUS_FT) continue;
    const candidateDir = candidate.spline.getTangentAt(hit.t);
    if (dirA.dot(candidateDir) > -0.7) continue; // must run roughly the opposite direction
    if (!best || hit.distSq < best.distSq) {
      best = { edgeId: candidate.id, point: hit.point, dir: candidateDir, distSq: hit.distSq };
    }
  }

  if (!best) return null;

  const dirB = best.dir;
  const nodeAPos = hitA.point;
  const nodeBPos = best.point;

  const lateralGapFt = Math.hypot(nodeBPos.x - nodeAPos.x, nodeBPos.z - nodeAPos.z);
  const loopRadiusFt = Math.max(TEXAS_TURNAROUND_MIN_RADIUS_FT, lateralGapFt / 2 + 10);
  const lateralSign =
    Math.sign((nodeBPos.x - nodeAPos.x) * right.x + (nodeBPos.z - nodeAPos.z) * right.z) || 1;

  const controlPoint1: [number, number, number] = [
    nodeAPos.x + dirA.x * loopRadiusFt * 0.6 + right.x * lateralSign * loopRadiusFt,
    nodeAPos.y,
    nodeAPos.z + dirA.z * loopRadiusFt * 0.6 + right.z * lateralSign * loopRadiusFt,
  ];
  const controlPoint2: [number, number, number] = [
    nodeBPos.x - dirB.x * loopRadiusFt * 0.6 + right.x * lateralSign * loopRadiusFt,
    nodeBPos.y,
    nodeBPos.z - dirB.z * loopRadiusFt * 0.6 + right.z * lateralSign * loopRadiusFt,
  ];

  const points = [
    new THREE.Vector3(nodeAPos.x, nodeAPos.y, nodeAPos.z),
    new THREE.Vector3(...controlPoint1),
    new THREE.Vector3(...controlPoint2),
    new THREE.Vector3(nodeBPos.x, nodeBPos.y, nodeBPos.z),
  ];
  const lengthFt = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5).getLength();

  return {
    targetEdgeId: best.edgeId,
    nodeAPoint: [nodeAPos.x, nodeAPos.y, nodeAPos.z],
    nodeBPoint: [nodeBPos.x, nodeBPos.y, nodeBPos.z],
    controlPoint1,
    controlPoint2,
    lengthFt,
  };
}

function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/**
 * Buckets a node's incoming edges into two traffic-signal phase groups
 * using approach heading: edges arriving roughly head-on to each other
 * (opposing through movements) or from the same direction share a phase,
 * everything else goes to the other phase. A reasonable default for T- and
 * 4-way junctions without requiring the user to hand-assign phases.
 */
export function computeSignalPhaseGroups(
  nodeId: string,
  edges: EdgeSpec[],
  nodesById: Map<string, NodeSpec>
): { groupA: string[]; groupB: string[] } {
  const incoming = edges.filter((e) => e.toNodeId === nodeId);
  const headings = incoming
    .map((e) => {
      const from = nodesById.get(e.fromNodeId);
      const to = nodesById.get(e.toNodeId);
      if (!from || !to) return null;
      const dx = to.position[0] - from.position[0];
      const dz = to.position[2] - from.position[2];
      return { id: e.id, angle: Math.atan2(dz, dx) };
    })
    .filter((h): h is { id: string; angle: number } => h !== null);

  const groupA: string[] = [];
  const groupB: string[] = [];
  if (headings.length === 0) return { groupA, groupB };

  const ref = headings[0].angle;
  for (const h of headings) {
    const diff = angleDiff(h.angle, ref);
    const diffOpposite = angleDiff(h.angle, ref + Math.PI);
    if (diff < Math.PI / 4 || diffOpposite < Math.PI / 4) {
      groupA.push(h.id);
    } else {
      groupB.push(h.id);
    }
  }
  return { groupA, groupB };
}
