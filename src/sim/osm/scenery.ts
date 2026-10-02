/**
 * Buildings and water from OpenStreetMap, turned into simple footprints in the game's own coordinates (feet, +x east,
 * +z south), ready for the renderer to extrude. Pure, so the build script and the browser share it.
 * Map data © OpenStreetMap contributors, ODbL.
 */
import type { NetworkSnapshot } from "../types";

const FT_PER_M = 3.28084;

export interface SceneryData {
  /** Footprint as flat [x0, z0, x1, z1, ...] feet, and height in feet. */
  buildings: { p: number[]; h: number }[];
  /** Water polygons as flat [x0, z0, x1, z1, ...] feet. */
  water: number[][];
}

export const EMPTY_SCENERY: SceneryData = { buildings: [], water: [] };

interface SceneryWay {
  id: number;
  geometry?: ({ lat: number; lon: number } | null)[];
  tags?: Record<string, string>;
  type: string;
}

const MAX_BUILDINGS = 450;
const MAX_WATER = 40;
const MAX_HEIGHT_FT = 650;

function area(pts: { x: number; z: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}

/** Douglas-Peucker on the ground plane, keeping the polygon closed and small. */
function simplify(pts: { x: number; z: number }[], tol: number): { x: number; z: number }[] {
  if (pts.length <= 4) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let wi = -1;
    const A = pts[a];
    const B = pts[b];
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const len = Math.hypot(dx, dz) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - A.x) * dz - (pts[i].z - A.z) * dx) / len;
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (worst > tol && wi > 0) {
      keep[wi] = true;
      stack.push([a, wi], [wi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function buildingHeightFt(tags: Record<string, string>, footprintArea: number): number {
  const m = Number.parseFloat(tags.height ?? "");
  if (Number.isFinite(m) && m > 0) return Math.min(MAX_HEIGHT_FT, Math.max(12, m * FT_PER_M));
  const levels = Number.parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels) && levels > 0) return Math.min(MAX_HEIGHT_FT, Math.max(12, levels * 11.5));
  // No data: a small footprint is a house, a large one a block of offices or a warehouse.
  return footprintArea > 20000 ? 36 : footprintArea > 4000 ? 30 : 20;
}

/** Spatial lookup of ground-level road pavement, so buildings aren't placed on the road. */
function roadSamples(network: NetworkSnapshot): Map<string, { x: number; z: number; r: number }[]> {
  const cell = 80;
  const grid = new Map<string, { x: number; z: number; r: number }[]>();
  const nodes = new Map(network.nodes.map((n) => [n.id, n]));
  for (const e of network.edges) {
    const a = nodes.get(e.fromNodeId);
    const b = nodes.get(e.toNodeId);
    if (!a || !b) continue;
    const pts = [a.position, ...e.interiorPoints, b.position];
    // a deck well above ground doesn't keep buildings away from the ground beneath it
    const r = (e.lanes * e.laneWidthFt) / 2 + 16;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0, z0] = pts[i];
      const [x1, y1, z1] = pts[i + 1];
      if (Math.min(y0, y1) > 10) continue;
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 20));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
        const arr = grid.get(key);
        const sample = { x, z, r };
        if (arr) arr.push(sample);
        else grid.set(key, [sample]);
      }
    }
  }
  return grid;
}

function nearRoad(grid: ReturnType<typeof roadSamples>, x: number, z: number, pad: number): boolean {
  const cell = 80;
  const cx = Math.floor(x / cell);
  const cz = Math.floor(z / cell);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get(`${cx + dx},${cz + dz}`);
      if (!arr) continue;
      for (const s of arr) if (Math.hypot(s.x - x, s.z - z) < s.r + pad) return true;
    }
  }
  return false;
}

/** Projects OSM lat/lon to the same feet coordinates the road converter uses for this box. */
export function makeProjector(bbox: [number, number, number, number]) {
  const [s, w, n, e] = bbox;
  const lat0 = (s + n) / 2;
  const lon0 = (w + e) / 2;
  return (lat: number, lon: number) => ({
    x: (lon - lon0) * Math.cos((lat0 * Math.PI) / 180) * 111320 * FT_PER_M,
    z: -(lat - lat0) * 110540 * FT_PER_M,
  });
}

export function convertScenery(bbox: [number, number, number, number], elements: SceneryWay[], network: NetworkSnapshot): SceneryData {
  const project = makeProjector(bbox);
  const [s, w, n, e] = bbox;
  const inside = (lat: number, lon: number) => lat >= s && lat <= n && lon >= w && lon <= e;
  const grid = roadSamples(network);
  const buildings: { p: number[]; h: number; area: number }[] = [];
  const water: { p: number[]; area: number }[] = [];

  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
    const tags = el.tags ?? {};
    const isBuilding = !!tags.building && tags.building !== "no";
    const isWater = tags.natural === "water" || tags.waterway === "riverbank" || tags.landuse === "reservoir";
    if (!isBuilding && !isWater) continue;

    const raw = el.geometry.filter((g): g is { lat: number; lon: number } => !!g);
    if (raw.length < 4) continue;
    if (isWater) {
      // Water can run off the box: clamp it to the edge rather than drop it
      const pts = raw.map((g) => project(Math.min(n, Math.max(s, g.lat)), Math.min(e, Math.max(w, g.lon))));
      const a = area(pts);
      if (a < 4000) continue;
      const simple = simplify(pts, 6);
      if (simple.length < 3) continue;
      water.push({ p: simple.flatMap((q) => [Math.round(q.x), Math.round(q.z)]), area: a });
      continue;
    }

    if (!raw.every((g) => inside(g.lat, g.lon))) continue;
    const pts = raw.map((g) => project(g.lat, g.lon));
    const a = area(pts);
    if (a < 150) continue;
    const cx = pts.reduce((acc, q) => acc + q.x, 0) / pts.length;
    const cz = pts.reduce((acc, q) => acc + q.z, 0) / pts.length;
    if (nearRoad(grid, cx, cz, 4) || pts.some((q) => nearRoad(grid, q.x, q.z, -2))) continue;
    const simple = simplify(pts.slice(0, -1), 3);
    if (simple.length < 3) continue;
    buildings.push({ p: simple.flatMap((q) => [Math.round(q.x), Math.round(q.z)]), h: Math.round(buildingHeightFt(tags, a)), area: a });
  }

  // Keep the most visible ones if there are too many: tall and big first.
  buildings.sort((x, y) => y.h * Math.sqrt(y.area) - x.h * Math.sqrt(x.area));
  water.sort((x, y) => y.area - x.area);
  return {
    buildings: buildings.slice(0, MAX_BUILDINGS).map(({ p, h }) => ({ p, h })),
    water: water.slice(0, MAX_WATER).map((x) => x.p),
  };
}

/** The Overpass query for a box's buildings and water. */
export function sceneryQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90];(way["building"](${box});way["natural"="water"](${box});way["waterway"="riverbank"](${box});way["landuse"="reservoir"](${box}););out body geom;`;
}
