/**
 * Turns OpenStreetMap roads (an Overpass `out body geom` response) into a Road Constructor network. Pure: no
 * file or network access, so the same code runs in the build script that bakes the real-city levels and in the
 * browser for "load any place".
 * Map data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright).
 */
import { assembleNetwork, computeRoute, computeSignalPhaseGroups } from "../network";
import type { EdgeSpec, NetworkSnapshot, NodeSpec } from "../types";
import { ROAD_CLASSES, type ElevationLevelId, type RoadClassId } from "../roadClasses";

const FT_PER_M = 3.28084;

/** What the converter needs to know about the box it was given. */
export interface ConvertConfig {
  /** [south, west, north, east] in degrees. */
  bbox: [number, number, number, number];
  /** Scales every entry's demand. */
  demandScale: number;
}

export interface OsmWay {
  id: number;
  nodes: number[];
  geometry: ({ lat: number; lon: number } | null)[];
  tags: Record<string, string>;
}
export interface OsmData {
  elements: (OsmWay & { type: string; lat?: number; lon?: number })[];
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

function buildNetwork(city: ConvertConfig, data: OsmData) {
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
    // A node where a tunnel meets a bridge is a data quirk (mismatched layer tags): ground level is the sane meeting point.
    if (hs.some((h) => h > 0) && hs.some((h) => h < 0)) return 0;
    return hs.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), hs[0]);
  };

  // Real ramps climb gently; the raw layer heights would have them climb 26 ft or more in a couple of hundred feet,
  // which no truck can drive. Relax the node heights so no road is steeper than the game's own 6% design maximum:
  // a deck rises as fast as it is allowed to from wherever it meets the ground, and stays level above that.
  const MAX_GRADE = 0.06;
  const finalY = new Map<number, number>();
  const links: { a: number; b: number; len: number }[] = [];
  for (const d of drafts) {
    const pts = d.seg.pts;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (len > 6) links.push({ a: pts[0].id, b: pts[pts.length - 1].id, len });
  }
  for (const l of links) {
    finalY.set(l.a, nodeY(l.a));
    finalY.set(l.b, nodeY(l.b));
  }
  for (let pass = 0; pass < 200; pass++) {
    let changed = false;
    for (const l of links) {
      const reach = MAX_GRADE * l.len;
      const ha = finalY.get(l.a)!;
      const hb = finalY.get(l.b)!;
      const diff = ha - hb;
      if (Math.abs(diff) > reach) {
        // Whichever end is further from ground level gives way: a bridge end comes down, a tunnel end comes up.
        const moveA = Math.abs(ha) > Math.abs(hb) || (Math.abs(ha) === Math.abs(hb) && ha > hb);
        if (moveA) finalY.set(l.a, hb + Math.sign(diff) * reach);
        else finalY.set(l.b, ha - Math.sign(diff) * reach);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const gradedY = (id: number) => finalY.get(id) ?? nodeY(id);

  const nodes = new Map<number, NodeSpec>();
  const ensureNode = (p: Pt): string => {
    const id = `n${p.id}`;
    if (!nodes.has(p.id)) nodes.set(p.id, { id, position: [round1(p.x), round1(gradedY(p.id)), round1(p.z)] });
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
    const startY = gradedY(pts[0].id);
    const endY = gradedY(pts[pts.length - 1].id);
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
    const interior: [number, number, number][] = [];
    for (let i = 1; i < shape.length - 1; i++) {
      let dist = 0;
      if (h !== 0) {
        dist = (total * i) / (shape.length - 1);
      } else {
        // for flat edges the interior y is simply the node height blend
        dist = 0;
      }
      // Along an elevated or sunken way the deck climbs from each end at the maximum grade and levels off at the
      // way's own height, so a bridge between two ground-level nodes still rises to clear what it crosses.
      let y: number;
      if (h !== 0) {
        const up = startY + MAX_GRADE * dist;
        const down = endY + MAX_GRADE * (total - dist);
        const sunkUp = startY - MAX_GRADE * dist;
        const sunkDown = endY - MAX_GRADE * (total - dist);
        y = h > 0 ? Math.min(h, up, down) : Math.max(h, sunkUp, sunkDown);
      } else {
        y = startY + (endY - startY) * (cum[i] / total);
      }
      interior.push([round1(shape[i].x), round1(y), round1(shape[i].z)]);
    }

    // Round off the knees where a climb meets the level deck (two passes of a 1-2-1 average on the interior heights,
    // end points held), so the curve through them doesn't overshoot into a steeper stretch than the grade limit.
    if (h !== 0 && interior.length >= 3) {
      for (let pass = 0; pass < 2; pass++) {
        const ys = interior.map((p) => p[1]);
        for (let i = 1; i < interior.length - 1; i++) interior[i][1] = round1((ys[i - 1] + 2 * ys[i] + ys[i + 1]) / 4);
      }
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

function addControlsAndZones(city: ConvertConfig, nodes: NodeSpec[], edges: EdgeSpec[], signalNodes: Set<number>) {
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


export interface ConvertResult {
  network: NetworkSnapshot;
  stats: { edges: number; nodes: number; lengthMiles: number; signals: number; entries: number; dests: number; extentFt: [number, number]; elevationLevels: number };
}

/** The whole conversion: clip, split, classify, add signals and entries/exits, keep the connected main network, and prune dead zones. */
export function convertOsm(city: ConvertConfig, data: OsmData): ConvertResult {
  const raw = buildNetwork(city, data);
  const main = keepMainComponent([...raw.nodes.values()], raw.edges);
  const extras = addControlsAndZones(city, main.nodes, main.edges, raw.signalNodes);
  const snapshot: NetworkSnapshot = { nodes: main.nodes, edges: main.edges };
  pruneUnreachableZones(snapshot, extras);
  // Prove it assembles (throws on a dangling reference) and report its size.
  const net = assembleNetwork(snapshot);
  const lengthFt = net.edges.reduce((acc, e) => acc + e.length, 0);
  const xs = main.nodes.map((n) => n.position[0]);
  const zs = main.nodes.map((n) => n.position[2]);
  return {
    network: snapshot,
    stats: {
      edges: main.edges.length,
      nodes: main.nodes.length,
      lengthMiles: lengthFt / 5280,
      signals: extras.signals,
      entries: extras.entries,
      dests: extras.dests,
      extentFt: [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)],
      elevationLevels: new Set(main.edges.map((e) => e.elevationLevelId)).size,
    },
  };
}
