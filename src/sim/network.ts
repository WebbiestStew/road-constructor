import * as THREE from "three";
import { ROAD_CLASSES } from "./roadClasses";
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
      priority: roadClass.priority,
      isFreeway: spec.roadClassId === "highway" || spec.roadClassId === "motorway",
      isElevated: computeIsElevated(spline),
      zone: spec.zone,
      nextEdgeIds: [],
    };
  });

  const edgesById = new Map(edges.map((e) => [e.id, e]));
  for (const edge of edges) {
    edge.nextEdgeIds = edges
      .filter((e2) => e2.fromNodeId === edge.toNodeId)
      .map((e2) => e2.id);
  }

  return { nodesById, edges, edgesById };
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
