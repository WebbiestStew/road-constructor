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
  LaneMove,
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

/** Builds a `nodeId -> distinct neighbor node ids` map from every edge's endpoints, direction-agnostic (a two-way pair of edges between the same two nodes still counts as one neighbor). Used to tell a plain "bend point" mid-road (exactly one neighbor on each side) apart from a dead end or a real multi-way junction, which should keep a straight, unsmoothed approach. */
function buildNeighborsByNode(edges: EdgeSpec[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = map.get(a);
    if (!set) {
      set = new Set();
      map.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    link(e.fromNodeId, e.toNodeId);
    link(e.toNodeId, e.fromNodeId);
  }
  return map;
}

/** If `nodeId` has exactly one neighbor other than `exclude`, returns that neighbor's id — otherwise null (a dead end, or a real junction with no single unambiguous "through" direction). */
function singleOtherNeighbor(
  neighborsByNode: Map<string, Set<string>>,
  nodeId: string,
  exclude: string
): string | null {
  const neighbors = neighborsByNode.get(nodeId);
  if (!neighbors || neighbors.size !== 2) return null;
  for (const id of neighbors) {
    if (id !== exclude) return id;
  }
  return null;
}

function buildSpline(
  spec: EdgeSpec,
  nodesById: Map<string, NodeSpec>,
  neighborsByNode: Map<string, Set<string>>
): THREE.CatmullRomCurve3 {
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

  // A flat (or near-flat) edge with no authored shape gets its endpoint
  // tangents blended with whatever road continues past each end — a plain
  // "bend point" the player tapped into a road while drawing keeps
  // travelling smoothly through it instead of the pavement kinking to a
  // sharp vertex where two dead-straight edges meet. A dead end or a real
  // multi-way junction has no single unambiguous "continuing" direction, so
  // that end is left as a straight approach exactly as before — only a
  // node with precisely one neighbor on the far side counts as a bend.
  if (spec.interiorPoints.length === 0) {
    const fromV = new THREE.Vector3(...from);
    const toV = new THREE.Vector3(...to);
    const prevNeighborId = singleOtherNeighbor(neighborsByNode, spec.fromNodeId, spec.toNodeId);
    const nextNeighborId = singleOtherNeighbor(neighborsByNode, spec.toNodeId, spec.fromNodeId);
    const prevNode = prevNeighborId ? nodesById.get(prevNeighborId) : undefined;
    const nextNode = nextNeighborId ? nodesById.get(nextNeighborId) : undefined;

    if (prevNode || nextNode) {
      const chordLength = toV.distanceTo(fromV);
      const straightDir = toV.clone().sub(fromV).normalize();
      // Tangent direction follows the neighboring segment (Catmull-Rom
      // style: "prev -> to" / "from -> next"), but its magnitude is scaled
      // to this edge's own length rather than the neighbor's — otherwise a
      // long lead-in segment feeding a short one would wildly overshoot the
      // control points and bulge or loop the curve.
      // Horizontal only: this edge is flat, and if the neighbouring road climbs (a ramp onto a viaduct), letting its
      // rise tilt our tangent drags the control points below ground and buries the end of the road, leaving only
      // the barrier tops poking out of the grass.
      const flatten = (v: THREE.Vector3) => {
        v.y = 0;
        return v.lengthSq() > 1e-6 ? v.normalize() : straightDir.clone();
      };
      const startDir = prevNode
        ? flatten(toV.clone().sub(new THREE.Vector3(...prevNode.position)))
        : straightDir;
      const endDir = nextNode
        ? flatten(new THREE.Vector3(...nextNode.position).sub(fromV))
        : straightDir;

      const control1 = fromV.clone().addScaledVector(startDir, chordLength / 3);
      const control2 = toV.clone().addScaledVector(endDir, -chordLength / 3);
      const bezier = new THREE.CubicBezierCurve3(fromV, control1, control2, toV);

      // Resample as a CatmullRomCurve3 (rather than returning the Bezier
      // directly) so every downstream consumer of Edge3D.spline keeps
      // working against the exact same curve type unchanged.
      const sampleCount = 12;
      const sampled: THREE.Vector3[] = [];
      for (let i = 0; i <= sampleCount; i++) {
        sampled.push(bezier.getPoint(i / sampleCount));
      }
      return new THREE.CatmullRomCurve3(sampled, false, "catmullrom", 0.5);
    }
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
  const neighborsByNode = buildNeighborsByNode(snapshot.edges);

  const edges: Edge3D[] = snapshot.edges.map((spec) => {
    const spline = buildSpline(spec, nodesById, neighborsByNode);
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
      manualLaneMoves: spec.laneMoves ?? null,
      nextMoves: new Map(),
      laneAllowed: null,
      laneMoves: Array.from({ length: spec.lanes }, () => ["straight" as LaneMove]),
      autoLaneMoves: Array.from({ length: spec.lanes }, () => ["straight" as LaneMove]),
    };
  });

  const edgesById = new Map(edges.map((e) => [e.id, e]));
  for (const edge of edges) {
    edge.nextEdgeIds = edges
      .filter((e2) => e2.fromNodeId === edge.toNodeId)
      .map((e2) => e2.id);
  }

  for (const edge of edges) {
    computeLaneUse(edge, edgesById);
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
const STRAIGHT_HALF_ANGLE = (30 * Math.PI) / 180;

/** Buckets an exit by the signed heading change from this edge's end to the next edge's start (positive = right). */
function classifyMove(edge: Edge3D, next: Edge3D): { move: LaneMove; score: number } {
  const tangentEnd = edge.spline.getTangentAt(1);
  const rightEnd = new THREE.Vector3().crossVectors(tangentEnd, UP).normalize();
  const tangentNext = next.spline.getTangentAt(0);
  const score = tangentNext.dot(rightEnd);
  const angle = Math.atan2(score, tangentNext.dot(tangentEnd));
  if (Math.abs(angle) < STRAIGHT_HALF_ANGLE) return { move: "straight", score };
  // Near-reversals (U-turns) read as left, as they do in real lane signage.
  if (angle > 0 && angle < Math.PI * 0.83) return { move: "right", score };
  return { move: "left", score };
}

function isValidManualMoves(edge: Edge3D, moves: LaneMove[][] | null): moves is LaneMove[][] {
  return !!moves && moves.length === edge.lanes && moves.every((m) => m.length > 0);
}

/**
 * Works out which lanes may take which exit. Automatic mode splits lanes into
 * contiguous left-to-right ranges ordered by exit heading; manual mode (player
 * lane arrows) allows exactly the moves painted on each lane, falling back to
 * "any lane" for an exit no lane can reach so the player can't strand traffic.
 * Safe to call again after a live patch.
 */
export function computeLaneUse(edge: Edge3D, edgesById: Map<string, Edge3D>): void {
  const straightAll = () => Array.from({ length: edge.lanes }, () => ["straight" as LaneMove]);
  edge.nextMoves = new Map();
  edge.laneAllowed = null;
  edge.laneMoves = straightAll();
  edge.autoLaneMoves = straightAll();

  // A U-turn onto the road's own opposite direction is never painted on a lane (real roads don't), and counting it
  // would fork the lanes of every plain mid-block node into a fake "turn left" arrow.
  const nextEdges = edge.nextEdgeIds
    .map((id) => edgesById.get(id))
    .filter((e): e is Edge3D => !!e)
    .filter((e) => !(e.fromNodeId === edge.toNodeId && e.toNodeId === edge.fromNodeId));
  if (nextEdges.length === 0) return;

  const scored = nextEdges.map((ne) => {
    const c = classifyMove(edge, ne);
    edge.nextMoves.set(ne.id, c.move);
    return { id: ne.id, move: c.move, score: c.score };
  });
  if (nextEdges.length < 2) return;

  // Automatic: contiguous ranges ordered left-to-right by exit heading.
  scored.sort((a, b) => a.score - b.score);
  const lanes = edge.lanes;
  const count = scored.length;
  const base = Math.floor(lanes / count);
  let remainder = lanes - base * count;
  const autoAllowed = new Map<string, boolean[]>();
  const autoMoves: Set<LaneMove>[] = Array.from({ length: lanes }, () => new Set<LaneMove>());
  let cursor = 0;
  for (const s of scored) {
    let laneCount = base;
    if (remainder > 0) {
      laneCount += 1;
      remainder -= 1;
    }
    if (laneCount < 1) laneCount = 1;
    const start = Math.min(cursor, lanes - 1);
    const end = Math.min(lanes - 1, cursor + laneCount - 1);
    const allowed = new Array<boolean>(lanes).fill(false);
    for (let i = start; i <= end; i++) {
      allowed[i] = true;
      autoMoves[i].add(s.move);
    }
    autoAllowed.set(s.id, allowed);
    cursor = end + 1;
  }
  edge.autoLaneMoves = autoMoves.map((set) => (set.size > 0 ? orderMoves(set) : ["straight"]));

  if (isValidManualMoves(edge, edge.manualLaneMoves)) {
    const manual = edge.manualLaneMoves;
    const allowedByNext = new Map<string, boolean[]>();
    for (const s of scored) {
      const arr = manual.map((moves) => moves.includes(s.move));
      allowedByNext.set(s.id, arr.some(Boolean) ? arr : new Array<boolean>(lanes).fill(true));
    }
    edge.laneAllowed = allowedByNext;
    edge.laneMoves = manual.map((m) => orderMoves(new Set(m)));
  } else {
    edge.laneAllowed = autoAllowed;
    edge.laneMoves = edge.autoLaneMoves;
  }
}

function orderMoves(set: Set<LaneMove>): LaneMove[] {
  return (["left", "straight", "right"] as LaneMove[]).filter((m) => set.has(m));
}

/** Applies a live edit (speed limit and/or lane arrows) to an assembled edge in place. */
export function patchEdge(
  edge: Edge3D,
  edgesById: Map<string, Edge3D>,
  patch: { speedLimitMph: number; laneMoves: LaneMove[][] | null }
): void {
  edge.speedLimitMph = patch.speedLimitMph;
  edge.manualLaneMoves = patch.laneMoves;
  computeLaneUse(edge, edgesById);
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
