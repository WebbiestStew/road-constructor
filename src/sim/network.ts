import * as THREE from "three";
import { ROAD_CLASSES, ROUNDABOUT_PRIORITY } from "./roadClasses";
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

function buildSpline(spec: EdgeSpec, nodesById: Map<string, NodeSpec>): THREE.CatmullRomCurve3 {
  const fromNode = nodesById.get(spec.fromNodeId);
  const toNode = nodesById.get(spec.toNodeId);
  if (!fromNode || !toNode) {
    throw new Error(`Edge ${spec.id} references unknown node`);
  }
  const points: THREE.Vector3[] = [new THREE.Vector3(...fromNode.position)];
  for (const p of spec.interiorPoints) points.push(new THREE.Vector3(...p));
  points.push(new THREE.Vector3(...toNode.position));
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
      priority: spec.isRoundaboutRing ? ROUNDABOUT_PRIORITY : roadClass.priority,
      isFreeway: spec.roadClassId === "highway" || spec.roadClassId === "motorway",
      isElevated: computeIsElevated(spline),
      zone: spec.zone,
      isRoundaboutRing: spec.isRoundaboutRing ?? false,
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

  const nextEdges = edge.nextEdgeIds.map((id) => edgesById.get(id)).filter((e): e is Edge3D => !!e);
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
