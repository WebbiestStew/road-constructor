import type { EdgeSpec, NodeSpec } from "./types";

/**
 * Land use: houses, jobs and shops placed beside the roads. They are what trips are for. A home sends cars out along
 * the nearest road (an entry, with demand that grows with its size); a workplace or a shop is somewhere to go (a
 * destination). So the player lays out a city and the traffic follows, instead of the traffic being a number on a road.
 */

export type LandUseKind = "home" | "work" | "shop";

export interface LandUse {
  id: string;
  kind: LandUseKind;
  /** Ground position, feet. */
  position: [number, number];
  /** 1 small, 2 medium, 3 large. */
  size: 1 | 2 | 3;
}

export const LAND_USE_KINDS: { id: LandUseKind; emoji: string; label: string; blurb: string; baseCost: number }[] = [
  { id: "home", emoji: "🏠", label: "Homes", blurb: "People live here and drive out along the nearest road.", baseCost: 40_000 },
  { id: "work", emoji: "🏢", label: "Jobs", blurb: "An office or a factory: somewhere those drivers are going.", baseCost: 80_000 },
  { id: "shop", emoji: "🛍️", label: "Shops", blurb: "A destination too, a little cheaper to build.", baseCost: 60_000 },
];

/** Cars per hour a home sends out at each size. */
export const HOME_DEMAND_VPH = [0, 90, 180, 270];
/** How far from a road a zone still counts as being on it. */
export const MAX_ROAD_DISTANCE_FT = 380;
/** A road must be at least this long to carry a marker. */
const MIN_ROAD_FT = 90;
const DEST_SPEED_MPH = 25;

export function landUseCost(kind: LandUseKind, size: number): number {
  return (LAND_USE_KINDS.find((k) => k.id === kind)?.baseCost ?? 50_000) * size;
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** The point on a road nearest `position`, and how far it is. Roads are taken as the polyline through their nodes and shaping points. */
export function nearestRoadPoint(edge: EdgeSpec, nodesById: Map<string, NodeSpec>, position: [number, number]): { distance: number; point: [number, number]; length: number } | null {
  const a = nodesById.get(edge.fromNodeId);
  const b = nodesById.get(edge.toNodeId);
  if (!a || !b) return null;
  const pts: [number, number][] = [[a.position[0], a.position[2]], ...edge.interiorPoints.map((p): [number, number] => [p[0], p[2]]), [b.position[0], b.position[2]]];
  let best = Infinity;
  let bestPoint: [number, number] = pts[0];
  let length = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    length += Math.hypot(bx - ax, bz - az);
    const d = distToSegment(position[0], position[1], ax, az, bx, bz);
    if (d < best) {
      best = d;
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((position[0] - ax) * dx + (position[1] - az) * dz) / len2)) : 0;
      bestPoint = [ax + t * dx, az + t * dz];
    }
  }
  return { distance: best, point: bestPoint, length };
}

/** The road a zone attaches to: the nearest drivable one within reach that doesn't already carry a marker the player set. */
export function attachRoad(edges: EdgeSpec[], nodesById: Map<string, NodeSpec>, position: [number, number], taken: Set<string>): { edgeId: string; point: [number, number] } | null {
  let best: { edgeId: string; point: [number, number]; distance: number } | null = null;
  for (const e of edges) {
    if (e.isRoundaboutRing || e.isTexasTurnaround || taken.has(e.id)) continue;
    const near = nearestRoadPoint(e, nodesById, position);
    if (!near || near.length < MIN_ROAD_FT || near.distance > MAX_ROAD_DISTANCE_FT) continue;
    if (!best || near.distance < best.distance) best = { edgeId: e.id, point: near.point, distance: near.distance };
  }
  return best ? { edgeId: best.edgeId, point: best.point } : null;
}

/**
 * Applies the zones to the roads: every marker an earlier pass put on a road is cleared, then each home becomes an
 * entry on its road (several homes on one road add up) and each job or shop a destination. Markers the player placed
 * with the Zone tool are never touched.
 */
export function applyLandUse(nodes: NodeSpec[], edges: EdgeSpec[], zones: LandUse[]): EdgeSpec[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const out = edges.map((e) => {
    if (!e.landUseId) return e;
    const next = { ...e };
    delete next.zone;
    delete next.landUseId;
    return next;
  });
  const playerZoned = new Set(out.filter((e) => e.zone).map((e) => e.id));
  const demand = new Map<string, number>();
  const destinations = new Set<string>();
  const owner = new Map<string, string>();
  // Homes first: they claim their roads, and a job or shop beside one finds the next nearest road to be a destination on.
  for (const z of zones) {
    if (z.kind !== "home") continue;
    const road = attachRoad(out, nodesById, z.position, playerZoned);
    if (!road) continue;
    owner.set(road.edgeId, owner.get(road.edgeId) ?? z.id);
    demand.set(road.edgeId, (demand.get(road.edgeId) ?? 0) + HOME_DEMAND_VPH[z.size]);
  }
  const homeRoads = new Set([...playerZoned, ...demand.keys()]);
  for (const z of zones) {
    if (z.kind === "home") continue;
    const road = attachRoad(out, nodesById, z.position, homeRoads);
    if (!road) continue;
    owner.set(road.edgeId, owner.get(road.edgeId) ?? z.id);
    destinations.add(road.edgeId);
  }
  return out.map((e) => {
    const id = owner.get(e.id);
    if (!id) return e;
    const d = demand.get(e.id);
    if (d) return { ...e, zone: { type: "entry" as const, demandVehPerHour: d }, landUseId: id };
    if (destinations.has(e.id)) return { ...e, zone: { type: "destination" as const, targetSpeedMph: DEST_SPEED_MPH }, landUseId: id };
    return e;
  });
}
