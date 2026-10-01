/**
 * Turns a box of real OpenStreetMap roads into a Road Constructor network.
 *
 *   npx tsx scripts/osm/build.ts            # every city
 *   npx tsx scripts/osm/build.ts toronto    # one city
 *
 * Raw downloads are cached in scripts/osm/cache/ (git-ignored); the result is written to src/sim/real/<key>.json.
 * Map data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright).
 */
import fs from "node:fs";
import path from "node:path";
import { assembleNetwork, computeRoute, computeSignalPhaseGroups } from "../../src/sim/network";
import type { EdgeSpec, NetworkSnapshot, NodeSpec } from "../../src/sim/types";
import { ROAD_CLASSES, type ElevationLevelId, type RoadClassId } from "../../src/sim/roadClasses";
import { CITIES, type CityConfig } from "./cities";

// Run from the repo root (see usage above), so paths are relative to it.
const CACHE_DIR = path.join(process.cwd(), "scripts/osm/cache");
const OUT_DIR = path.join(process.cwd(), "src/sim/real");
const MIRRORS = ["https://overpass-api.de", "https://lz4.overpass-api.de", "https://z.overpass-api.de"];
const USER_AGENT = "road-constructor-scenario-builder/1.0 (https://github.com/WebbiestStew/road-constructor)";

const FT_PER_M = 3.28084;

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

interface OsmWay {
  id: number;
  nodes: number[];
  geometry: ({ lat: number; lon: number } | null)[];
  tags: Record<string, string>;
}
interface OsmData {
  elements: (OsmWay & { type: string; lat?: number; lon?: number })[];
}

async function overpass(query: string): Promise<OsmData> {
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const host = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(`${host}/api/interpreter`, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, Accept: "*/*", "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith("{")) return JSON.parse(text) as OsmData;
      lastError = `${host}: HTTP ${res.status}`;
    } catch (e) {
      lastError = `${host}: ${String(e)}`;
    }
    await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
  }
  throw new Error(`Overpass failed (${lastError})`);
}

async function download(city: CityConfig): Promise<OsmData> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${city.key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as OsmData;
  const [s, w, n, e] = city.bbox;
  const bbox = `${s},${w},${n},${e}`;
  const hw = city.highways.join("|");
  const query = `[out:json][timeout:90];(way["highway"~"^(${hw})$"](${bbox});node["highway"="traffic_signals"](${bbox}););out body geom;`;
  console.log(`  downloading ${city.name}…`);
  const data = await overpass(query);
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

interface Pt {
  id: number;
  x: number;
  z: number;
}
interface Run {
  wayId: number;
  tags: Record<string, string>;
  pts: Pt[];
}

function parseSpeedMph(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kph)?/i.exec(raw.trim());
  if (!m) return fallback;
  const v = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const mph = unit === "mph" ? v : v * 0.621371; // OSM's unitless default is km/h
  return Math.max(10, Math.min(80, Math.round(mph / 5) * 5));
}

function classFor(highway: string): RoadClassId {
  switch (highway) {
    case "motorway":
      return "motorway";
    case "motorway_link":
    case "trunk":
      return "highway";
    case "trunk_link":
    case "primary":
    case "secondary":
      return "avenue";
    default:
      return "street"; // primary_link, secondary_link, tertiary, tertiary_link
  }
}

/** Ramps and links are single-lane roads even when their class is bigger. */
function isLink(highway: string) {
  return highway.endsWith("_link");
}

interface Elevation {
  level: ElevationLevelId;
  heightFt: number;
}
const GROUND: Elevation = { level: "ground", heightFt: 0 };

function elevationOf(tags: Record<string, string>): Elevation {
  const layer = Number.parseInt(tags.layer ?? "0", 10) || 0;
  if (tags.tunnel && tags.tunnel !== "no" && tags.tunnel !== "building_passage") return { level: "tunnel", heightFt: -35 };
  if (layer < 0) return { level: "tunnel", heightFt: -35 };
  const bridge = tags.bridge && tags.bridge !== "no";
  const effective = bridge ? Math.max(layer, 1) : layer;
  if (effective <= 0) return GROUND;
  // Real stacked decks need generous separation or the game flags them as too low to drive under (it wants ~15 ft
  // clear), so each layer is 26 ft rather than the editor's 20 ft tiers. The level id is just a label here: the
  // geometry comes from the heights below.
  const heightFt = Math.min(effective, 4) * 26;
  return { level: effective === 1 ? "tier1" : effective === 2 ? "tier2" : "tier3", heightFt };
}

function smoothstep(t: number) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** Douglas-Peucker on the XZ plane. */
function simplify(pts: { x: number; z: number }[], tolFt: number): { x: number; z: number }[] {
  if (pts.length <= 2) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const ax = pts[a].x, az = pts[a].z, bx = pts[b].x, bz = pts[b].z;
    const len = Math.hypot(bx - ax, bz - az) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (az - pts[i].z) - (ax - pts[i].x) * (bz - az)) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolFt && idx >= 0) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function buildNetwork(city: CityConfig, data: OsmData) {
  const [s, w, n, e] = city.bbox;
  const lat0 = (s + n) / 2;
  const lon0 = (w + e) / 2;
  const project = (lat: number, lon: number) => ({
    x: (lon - lon0) * Math.cos((lat0 * Math.PI) / 180) * 111320 * FT_PER_M,
    z: -(lat - lat0) * 110540 * FT_PER_M, // north is up the screen, so away from the camera (-z)
  });
  const inside = (lat: number, lon: number) => lat >= s && lat <= n && lon >= w && lon <= e;

  const signalNodes = new Set<number>();
  const runs: Run[] = [];
  for (const el of data.elements) {
    if (el.type === "node") {
      signalNodes.add(el.id);
      continue;
    }
    if (el.type !== "way" || !el.tags?.highway || !el.geometry) continue;
    let cur: Pt[] = [];
    const flush = () => {
      if (cur.length >= 2) runs.push({ wayId: el.id, tags: el.tags, pts: cur });
      cur = [];
    };
    el.geometry.forEach((g, i) => {
      if (!g || !inside(g.lat, g.lon)) return flush();
      const p = project(g.lat, g.lon);
      cur.push({ id: el.nodes[i], x: p.x, z: p.z });
    });
    flush();
  }

  // A node is a junction if two runs touch it or a run ends there.
  const touches = new Map<number, number>();
  for (const r of runs) for (const p of r.pts) touches.set(p.id, (touches.get(p.id) ?? 0) + 1);
  const isJunction = (r: Run, i: number) => i === 0 || i === r.pts.length - 1 || (touches.get(r.pts[i].id) ?? 0) >= 2;

  interface Seg {
    run: Run;
    pts: Pt[];
  }
  const segs: Seg[] = [];
  for (const r of runs) {
    let start = 0;
    for (let i = 1; i < r.pts.length; i++) {
      if (isJunction(r, i)) {
        segs.push({ run: r, pts: r.pts.slice(start, i + 1) });
        start = i;
      }
    }
  }

  const nodeHeights = new Map<number, number[]>();
  const nodePos = new Map<number, { x: number; z: number }>();
  const noteNode = (p: Pt, h: number) => {
    nodePos.set(p.id, { x: p.x, z: p.z });
    const arr = nodeHeights.get(p.id) ?? [];
    arr.push(h);
    nodeHeights.set(p.id, arr);
  };

  interface Draft {
    seg: Seg;
    elevation: Elevation;
    forward: boolean; // edge runs with the OSM way direction
    backward: boolean; // edge runs against it
    klass: RoadClassId;
    lanesF: number;
    lanesB: number;
    speed: number;
    ring: boolean;
    link: boolean;
  }
  const drafts: Draft[] = [];

  for (const seg of segs) {
    const tags = seg.run.tags;
    const hw = tags.highway;
    const elevation = elevationOf(tags);
    const ring = tags.junction === "roundabout" || tags.junction === "circular";
    const oneway = tags.oneway;
    const impliedOneway = hw === "motorway" || hw === "motorway_link" || ring;
    const reverseOnly = oneway === "-1" || oneway === "reverse";
    const isOne = reverseOnly || oneway === "yes" || oneway === "1" || oneway === "true" || (impliedOneway && oneway !== "no");
    const klass = ring ? "lane" : classFor(hw);
    const cls = ROAD_CLASSES[klass];
    const tagLanes = Number.parseInt(tags.lanes ?? "", 10);
    const link = isLink(hw);
    let lanesF = cls.lanesPerDirection;
    let lanesB = cls.lanesPerDirection;
    if (ring) lanesF = lanesB = 1;
    else if (isOne) {
      lanesF = lanesB = Number.isFinite(tagLanes) ? tagLanes : link ? 1 : cls.lanesPerDirection;
    } else {
      const lf = Number.parseInt(tags["lanes:forward"] ?? "", 10);
      const lb = Number.parseInt(tags["lanes:backward"] ?? "", 10);
      const half = Number.isFinite(tagLanes) ? Math.max(1, Math.ceil(tagLanes / 2)) : cls.lanesPerDirection;
      lanesF = Number.isFinite(lf) ? lf : half;
      lanesB = Number.isFinite(lb) ? lb : half;
    }
    const clampLanes = (v: number) => Math.max(1, Math.min(4, v));
    const draft: Draft = {
      seg,
      elevation,
      forward: !reverseOnly,
      backward: !isOne,
      klass,
      lanesF: clampLanes(lanesF),
      lanesB: clampLanes(lanesB),
      speed: ring ? 20 : parseSpeedMph(tags.maxspeed, cls.speedLimitMph),
      ring,
      link,
    };
    if (reverseOnly) draft.backward = true;
    drafts.push(draft);
    noteNode(seg.pts[0], elevation.heightFt);
    noteNode(seg.pts[seg.pts.length - 1], elevation.heightFt);
  }

  // A node shared by roads at different heights sits at the lowest, so ramps meet the ground and bridges rise from it.
  const nodeY = (id: number) => {
    const hs = nodeHeights.get(id) ?? [0];
    return hs.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), hs[0]);
  };

  const nodes = new Map<number, NodeSpec>();
  const ensureNode = (p: Pt): string => {
    const id = `n${p.id}`;
    if (!nodes.has(p.id)) nodes.set(p.id, { id, position: [round1(p.x), nodeY(p.id), round1(p.z)] });
    return id;
  };

  const edges: EdgeSpec[] = [];
  for (const d of drafts) {
    const pts = d.seg.pts;
    // Smooth, simplified shape; elevated edges get a vertical profile so a bridge climbs, spans and descends.
    const horizontal = simplify(pts, 7);
    const a = nodePos.get(pts[0].id)!;
    const b = nodePos.get(pts[pts.length - 1].id)!;
    void a;
    void b;
    const startY = nodeY(pts[0].id);
    const endY = nodeY(pts[pts.length - 1].id);
    const h = d.elevation.heightFt;

    // cumulative length along the simplified polyline
    const cum: number[] = [0];
    for (let i = 1; i < horizontal.length; i++) cum.push(cum[i - 1] + Math.hypot(horizontal[i].x - horizontal[i - 1].x, horizontal[i].z - horizontal[i - 1].z));
    const total = cum[cum.length - 1];
    if (total < 6) continue; // a stub too short to drive

    let shape = horizontal;
    if (h !== 0) {
      // resample so the climb has enough points to follow
      const step = 60;
      const count = Math.max(2, Math.ceil(total / step));
      const resampled: { x: number; z: number }[] = [];
      for (let i = 0; i <= count; i++) {
        const dist = (total * i) / count;
        let k = 1;
        while (k < cum.length - 1 && cum[k] < dist) k++;
        const t = cum[k] === cum[k - 1] ? 0 : (dist - cum[k - 1]) / (cum[k] - cum[k - 1]);
        resampled.push({ x: horizontal[k - 1].x + (horizontal[k].x - horizontal[k - 1].x) * t, z: horizontal[k - 1].z + (horizontal[k].z - horizontal[k - 1].z) * t });
      }
      shape = resampled;
    }
    const ramp = Math.min(260, total / 2);
    const interior: [number, number, number][] = [];
    for (let i = 1; i < shape.length - 1; i++) {
      let dist = 0;
      if (h !== 0) {
        dist = (total * i) / (shape.length - 1);
      } else {
        // for flat edges the interior y is simply the node height blend
        dist = 0;
      }
      let y = 0;
      if (h !== 0) {
        const fromStart = smoothstep(dist / ramp);
        const fromEnd = smoothstep((total - dist) / ramp);
        y = h - (h - startY) * (1 - fromStart) - (h - endY) * (1 - fromEnd);
        y = h > 0 ? Math.max(0, Math.min(h, y)) : Math.min(0, Math.max(h, y));
      } else {
        y = startY + (endY - startY) * (cum[i] / total);
      }
      interior.push([round1(shape[i].x), round1(y), round1(shape[i].z)]);
    }

    const fromId = ensureNode(pts[0]);
    const toId = ensureNode(pts[pts.length - 1]);
    if (fromId === toId) continue;
    const cls = ROAD_CLASSES[d.klass];
    const base = `w${d.seg.run.wayId}_${pts[0].id}`;
    const make = (id: string, from: string, to: string, interiorPts: [number, number, number][], lanes: number): EdgeSpec => ({
      id,
      fromNodeId: from,
      toNodeId: to,
      interiorPoints: interiorPts,
      roadClassId: d.klass,
      elevationLevelId: d.elevation.level,
      lanes,
      laneWidthFt: d.ring ? 14 : cls.laneWidthFt,
      speedLimitMph: d.speed,
      ...(d.ring ? { isRoundaboutRing: true } : {}),
    });
    if (d.forward) edges.push(make(`${base}f`, fromId, toId, interior, d.lanesF));
    if (d.backward) edges.push(make(`${base}b`, toId, fromId, [...interior].reverse(), d.lanesB));
  }

  return { nodes, edges, signalNodes, project };
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}

/** Keeps the largest weakly-connected piece; stray fragments of road at the box edge are noise. */
function keepMainComponent(nodes: NodeSpec[], edges: EdgeSpec[]): { nodes: NodeSpec[]; edges: EdgeSpec[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const nx = parent.get(c)!;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  for (const n of nodes) parent.set(n.id, n.id);
  for (const e of edges) parent.set(find(e.fromNodeId), find(e.toNodeId));
  const sizes = new Map<string, number>();
  for (const e of edges) sizes.set(find(e.fromNodeId), (sizes.get(find(e.fromNodeId)) ?? 0) + 1);
  let best = "";
  let bestSize = 0;
  for (const [k, v] of sizes) if (v > bestSize) ((best = k), (bestSize = v));
  const keptEdges = edges.filter((e) => find(e.fromNodeId) === best);
  const used = new Set<string>();
  for (const e of keptEdges) (used.add(e.fromNodeId), used.add(e.toNodeId));
  return { nodes: nodes.filter((n) => used.has(n.id)), edges: keptEdges };
}

function addControlsAndZones(city: CityConfig, nodes: NodeSpec[], edges: EdgeSpec[], signalNodes: Set<number>) {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const incident = new Map<string, EdgeSpec[]>();
  for (const e of edges) {
    for (const id of [e.fromNodeId, e.toNodeId]) {
      const arr = incident.get(id) ?? [];
      arr.push(e);
      incident.set(id, arr);
    }
  }

  // Traffic lights: OSM-signalised junctions with at least three real approaches.
  let signals = 0;
  for (const n of nodes) {
    const osmId = Number(n.id.slice(1));
    if (!signalNodes.has(osmId)) continue;
    const inc = incident.get(n.id) ?? [];
    const neighbours = new Set(inc.map((e) => (e.fromNodeId === n.id ? e.toNodeId : e.fromNodeId)));
    if (neighbours.size < 3 || inc.some((e) => e.isRoundaboutRing)) continue;
    const { groupA, groupB } = computeSignalPhaseGroups(n.id, edges, nodesById);
    if (groupA.length === 0 && groupB.length === 0) continue;
    n.control = { type: "signal", groupA, groupB, greenDurationS: 22, allRedDurationS: 2 };
    signals++;
  }

  // Entries and destinations at the dead ends where the map box cuts the road.
  const BASE_VPH: Record<RoadClassId, number> = { lane: 150, street: 220, avenue: 360, highway: 520, motorway: 650 };
  let entries = 0;
  let dests = 0;
  for (const n of nodes) {
    const inc = incident.get(n.id) ?? [];
    const neighbours = new Set(inc.map((e) => (e.fromNodeId === n.id ? e.toNodeId : e.fromNodeId)));
    if (neighbours.size !== 1) continue;
    for (const e of inc) {
      if (e.isRoundaboutRing) continue;
      if (e.fromNodeId === n.id) {
        const vph = Math.max(120, Math.min(2200, Math.round(BASE_VPH[e.roadClassId] * e.lanes * city.demandScale)));
        e.zone = { type: "entry", demandVehPerHour: vph };
        entries++;
      } else {
        e.zone = { type: "destination", targetSpeedMph: 25 };
        dests++;
      }
    }
  }
  return { signals, entries, dests };
}

/**
 * Real one-way ramps clipped at the map edge leave some entries that can't reach any exit and exits nothing can
 * reach. Those would just sit there, so drop their zones.
 */
function pruneUnreachableZones(snapshot: NetworkSnapshot, extras: { entries: number; dests: number }) {
  const net = assembleNetwork(snapshot);
  const entries = net.edges.filter((e) => e.zone?.type === "entry");
  const dests = net.edges.filter((e) => e.zone?.type === "destination");
  const reachedDest = new Set<string>();
  const dead = new Set<string>();
  for (const en of entries) {
    let any = false;
    for (const d of dests) {
      if (d.id === en.id) continue;
      if (computeRoute(net, en.id, d.id)) {
        any = true;
        reachedDest.add(d.id);
      }
    }
    if (!any) dead.add(en.id);
  }
  for (const d of dests) if (!reachedDest.has(d.id)) dead.add(d.id);
  for (const e of snapshot.edges) {
    if (dead.has(e.id)) delete e.zone;
  }
  extras.entries = entries.length - [...dead].filter((id) => entries.some((e) => e.id === id)).length;
  extras.dests = dests.length - [...dead].filter((id) => dests.some((e) => e.id === id)).length;
}

async function buildCity(city: CityConfig) {
  const data = await download(city);
  const raw = buildNetwork(city, data);
  const main = keepMainComponent([...raw.nodes.values()], raw.edges);
  const extras = addControlsAndZones(city, main.nodes, main.edges, raw.signalNodes);

  const snapshot: NetworkSnapshot = { nodes: main.nodes, edges: main.edges };
  pruneUnreachableZones(snapshot, extras);
  // Prove it assembles (throws on a dangling reference) and report its size.
  const net = assembleNetwork(snapshot);
  const lengthFt = net.edges.reduce((a, e) => a + e.length, 0);
  const xs = main.nodes.map((n) => n.position[0]);
  const zs = main.nodes.map((n) => n.position[2]);
  const meta = {
    key: city.key,
    name: city.name,
    bbox: city.bbox,
    attribution: "Map data © OpenStreetMap contributors (ODbL)",
    generated: new Date().toISOString().slice(0, 10),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${city.key}.json`);
  fs.writeFileSync(file, JSON.stringify({ meta, network: snapshot }));
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(
    `  ${city.name.padEnd(12)} ${main.edges.length} edges, ${main.nodes.length} nodes, ${Math.round(lengthFt / 5280)} mi of road, ` +
      `${extras.signals} signals, ${extras.entries} entries/${extras.dests} dests, ` +
      `extent ${Math.round(Math.max(...xs) - Math.min(...xs))}×${Math.round(Math.max(...zs) - Math.min(...zs))} ft, ` +
      `${new Set(main.edges.map((e) => e.elevationLevelId)).size} elevation levels, ${kb} KB`
  );
}

async function main() {
  const only = process.argv[2];
  for (const city of CITIES.filter((c) => !only || c.key === only)) {
    await buildCity(city);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
