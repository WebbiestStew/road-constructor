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
  nodes?: number[];
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


type LL = { lat: number; lon: number };

/**
 * Sea and big rivers from OpenStreetMap's coastline ways (land is on the left of each way, water on the right). The
 * ways are joined end to end, trimmed to the box, and each piece that crosses the box is closed up along the box edge
 * on its water side, which gives one polygon per stretch of water.
 */
export function coastlineWater(bbox: [number, number, number, number], ways: SceneryWay[]): number[][] {
  const project = makeProjector(bbox);
  const [s, w, n, e] = bbox;
  const coast = ways.filter((x) => x.type === "way" && x.tags?.natural === "coastline" && x.geometry && x.nodes && x.nodes.length > 1);
  // Join ways whose end node is another's start node.
  const byStart = new Map<number, SceneryWay>();
  for (const way of coast) byStart.set(way.nodes![0], way);
  const used = new Set<SceneryWay>();
  const hasPredecessor = new Set<number>();
  for (const way of coast) hasPredecessor.add(way.nodes![way.nodes!.length - 1]);
  const chains: LL[][] = [];
  const build = (first: SceneryWay) => {
    const pts: LL[] = [];
    let cur: SceneryWay | undefined = first;
    while (cur && !used.has(cur)) {
      used.add(cur);
      const g = cur.geometry!.filter((q): q is LL => !!q);
      pts.push(...(pts.length ? g.slice(1) : g));
      cur = byStart.get(cur.nodes![cur.nodes!.length - 1]);
    }
    if (pts.length > 1) chains.push(pts);
  };
  for (const way of coast) if (!hasPredecessor.has(way.nodes![0])) build(way);
  for (const way of coast) build(way); // whatever is left is part of a loop

  // Position along the box edge, clockwise from the south-west corner (north is up the screen).
  const W = e - w;
  const H = n - s;
  const perimeter = (lat: number, lon: number) => {
    const eps = 1e-9;
    if (Math.abs(lon - w) < eps) return lat - s; // west edge, going north
    if (Math.abs(lat - n) < eps) return H + (lon - w); // north edge, going east
    if (Math.abs(lon - e) < eps) return H + W + (n - lat); // east edge, going south
    return 2 * H + W + (e - lon); // south edge, going west
  };
  const corners: { at: number; lat: number; lon: number }[] = [
    { at: H, lat: n, lon: w },
    { at: H + W, lat: n, lon: e },
    { at: 2 * H + W, lat: s, lon: e },
    { at: 2 * H + 2 * W, lat: s, lon: w },
  ];
  const clipSegment = (a: LL, b: LL): { enter: LL | null; leave: LL | null; ins: boolean } => {
    const inA = a.lat >= s && a.lat <= n && a.lon >= w && a.lon <= e;
    const inB = b.lat >= s && b.lat <= n && b.lon >= w && b.lon <= e;
    if (inA && inB) return { enter: null, leave: null, ins: true };
    // Liang-Barsky against the box
    let t0 = 0;
    let t1 = 1;
    const dx = b.lon - a.lon;
    const dy = b.lat - a.lat;
    const p = [-dx, dx, -dy, dy];
    const q = [a.lon - w, e - a.lon, a.lat - s, n - a.lat];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return { enter: null, leave: null, ins: false };
      } else {
        const r = q[i] / p[i];
        if (p[i] < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (t0 > t1) return { enter: null, leave: null, ins: false };
    const at = (t: number): LL => ({ lat: Math.min(n, Math.max(s, a.lat + dy * t)), lon: Math.min(e, Math.max(w, a.lon + dx * t)) });
    return { enter: inA ? null : at(t0), leave: inB ? null : at(t1), ins: true };
  };

  // Cut every chain into the pieces that lie inside the box and run from one box edge to another.
  const onEdge = (q: LL) => Math.abs(q.lat - s) < 1e-9 || Math.abs(q.lat - n) < 1e-9 || Math.abs(q.lon - w) < 1e-9 || Math.abs(q.lon - e) < 1e-9;
  const pieces: { pts: LL[]; start: number; end: number }[] = [];
  for (const chain of chains) {
    let piece: LL[] = [];
    const flush = () => {
      if (piece.length > 1 && onEdge(piece[0]) && onEdge(piece[piece.length - 1])) {
        pieces.push({ pts: piece, start: perimeter(piece[0].lat, piece[0].lon), end: perimeter(piece[piece.length - 1].lat, piece[piece.length - 1].lon) });
      }
      piece = [];
    };
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const c = clipSegment(a, b);
      if (!c.ins) {
        flush();
        continue;
      }
      if (c.enter) {
        flush();
        piece.push(c.enter);
      } else if (piece.length === 0) piece.push(a);
      piece.push(c.leave ?? b);
      if (c.leave) flush();
    }
    flush();
  }

  // Water lies on the right of each piece. From where a piece leaves the box, walk the box edge clockwise to the next
  // piece that starts there; chaining pieces that way closes each stretch of water into one ring.
  const total = 2 * H + 2 * W;
  const gap = (from: number, to: number) => (to - from + total) % total;
  const polygons: number[][] = [];
  const done = new Set<number>();
  for (let first = 0; first < pieces.length; first++) {
    if (done.has(first)) continue;
    const ring: LL[] = [];
    let cur = first;
    for (let guard = 0; guard < pieces.length + 1; guard++) {
      done.add(cur);
      ring.push(...pieces[cur].pts);
      let next = -1;
      let best = Infinity;
      for (let k = 0; k < pieces.length; k++) {
        const g = gap(pieces[cur].end, pieces[k].start);
        if (g < best) {
          best = g;
          next = k;
        }
      }
      const toPerim = pieces[next].start;
      const span = gap(pieces[cur].end, toPerim);
      const between = corners
        .map((c) => ({ ...c, rel: gap(pieces[cur].end, c.at) }))
        .filter((c) => c.rel > 1e-9 && c.rel < span - 1e-9)
        .sort((x, y) => x.rel - y.rel);
      for (const c of between) ring.push({ lat: c.lat, lon: c.lon });
      if (next === first || done.has(next)) break;
      cur = next;
    }
    polygons.push(
      simplify(
        ring.map((q) => project(q.lat, q.lon)),
        10
      ).flatMap((q) => [Math.round(q.x), Math.round(q.z)])
    );
  }
  // Order the ring corners by sorting out duplicates, and drop slivers.
  return polygons.filter((p) => p.length >= 6);
}

/** The Overpass query for a box's buildings and water. */
export function sceneryQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90];(way["building"](${box});way["natural"="water"](${box});way["waterway"="riverbank"](${box});way["landuse"="reservoir"](${box}););out body geom;`;
}
