import { Builder, addSignal } from "./cityBuilder";
import type { NetworkSnapshot, ZoneSpec } from "./types";

/**
 * Pre-built cities for the Traffic Manager levels. The roads are fixed — the
 * player's job is to fix the flow with lane arrows, speed limits and signals.
 * Each city ships with a few deliberate faults, each fixable with one tool.
 */

/** Which planted faults a city has. `true` = all of them, `false` = none (the fixed version, used to calibrate). */
export interface Faults {
  speed: boolean;
  signal: boolean;
  arrows: boolean;
}
export type FaultSpec = boolean | Partial<Faults>;
function faultsOf(spec: FaultSpec): Faults {
  if (typeof spec === "boolean") return { speed: spec, signal: spec, arrows: spec };
  return { speed: false, signal: false, arrows: false, ...spec };
}

const ENTRY = (vph: number): ZoneSpec => ({ type: "entry", demandVehPerHour: vph });
const DEST: ZoneSpec = { type: "destination", targetSpeedMph: 25 };

const BLOCK = 420;
const REACH = 1100;

/**
 * Midtown: a two-by-two avenue grid, four signals, eight ways in and out.
 *  - Fault 1 (speed limits): two inner avenue blocks are posted 15 mph.
 *  - Fault 2 (signals): the north-west and south-east signals flip every 4 seconds, wasting their time on clearance.
 *  - Fault 3 (lane arrows): two approaches have a left-only lane that starves through traffic.
 * `faulty: false` builds the fixed version, used to calibrate targets.
 */
export function buildMidtown(spec: FaultSpec = true): NetworkSnapshot {
  const f = faultsOf(spec);
  const b = new Builder();
  const xs = [-BLOCK, BLOCK];
  const zs = [-BLOCK, BLOCK];
  const name = (x: number, z: number) => `j${x < 0 ? "W" : "E"}${z < 0 ? "N" : "S"}`;

  for (const x of xs) for (const z of zs) b.node(name(x, z), x, z);

  const demand = 1100;
  let seq = 0;
  const road = (a: string, c: string, zones?: { forward?: ZoneSpec; backward?: ZoneSpec }, limit?: number) => {
    const [f, bk] = b.road(0, `r${seq++}`, a, c, "avenue", "ground", zones);
    if (limit !== undefined) {
      for (const e of b.edges) if (e.id === f || e.id === bk) e.speedLimitMph = limit;
    }
    return [f, bk] as const;
  };

  // North-south avenues (x = -BLOCK, +BLOCK): entry from the top end, exit at the bottom end, and vice versa.
  for (const x of xs) {
    const top = b.node(`n${x}`, x, -REACH);
    const bottom = b.node(`s${x}`, x, REACH);
    road(top, name(x, -BLOCK), { forward: ENTRY(demand), backward: DEST });
    road(name(x, BLOCK), bottom, { forward: DEST, backward: ENTRY(demand) });
    // The segment between the two signals — fault 1 lives on the east avenue.
    road(name(x, -BLOCK), name(x, BLOCK), undefined, f.speed && x > 0 ? 15 : undefined);
  }
  // East-west avenues.
  for (const z of zs) {
    const left = b.node(`w${z}`, -REACH, z);
    const right = b.node(`e${z}`, REACH, z);
    road(left, name(-BLOCK, z), { forward: ENTRY(demand), backward: DEST });
    road(name(BLOCK, z), right, { forward: DEST, backward: ENTRY(demand) });
    road(name(-BLOCK, z), name(BLOCK, z), undefined, f.speed && z > 0 ? 15 : undefined);
  }

  for (const x of xs) for (const z of zs) {
    const id = name(x, z);
    addSignal(b, id, f.signal && (id === "jWN" || id === "jES") ? 4 : 20, 2);
  }

  if (f.arrows) {
    // Fault 3: on two approaches the right-hand lane is left-turn-only, leaving one lane for everything else.
    const leftOnly = (fromNode: string, toNode: string) => {
      const e = b.edges.find((ed) => ed.fromNodeId === fromNode && ed.toNodeId === toNode)!;
      e.laneMoves = [["straight", "right"], ["left"]];
    };
    leftOnly(`w${-BLOCK}`, "jWN");
    leftOnly(`s${BLOCK}`, "jES");
  }

  const nodes = [...b.nodes.values()];
  return { nodes, edges: b.edges };
}


/** Posts a speed limit on both directions of a road returned by `Builder.road`. */
function limitRoad(b: Builder, ids: readonly [string, string], mph: number) {
  for (const e of b.edges) if (e.id === ids[0] || e.id === ids[1]) e.speedLimitMph = mph;
}

/** Gives the approach edge running `fromNode -> toNode` a left-only lane on its right-hand side. */
function leftOnlyLane(b: Builder, fromNode: string, toNode: string) {
  const e = b.edges.find((ed) => ed.fromNodeId === fromNode && ed.toNodeId === toNode);
  if (e) e.laneMoves = [["straight", "right"], ["left"]];
}

/**
 * Harbor Drive: one long waterfront avenue with five signalized cross streets in a row.
 *  - Speed limits: the two middle blocks are posted 15 mph.
 *  - Signals: the three middle lights flip every 3 seconds.
 *  - Lane arrows: three approaches to the centre light have a left-only lane.
 */
export function buildHarborDrive(spec: FaultSpec = true): NetworkSnapshot {
  const f = faultsOf(spec);
  const b = new Builder();
  const xs = [-1200, -600, 0, 600, 1200];
  const junction = (i: number) => `h${i}`;
  xs.forEach((x, i) => b.node(junction(i), x, 0));
  const west = b.node("hW", -2000, 0);
  const east = b.node("hE", 2000, 0);

  let seq = 0;
  const main = (a: string, c: string, zones?: { forward?: ZoneSpec; backward?: ZoneSpec }) =>
    b.road(0, `m${seq++}`, a, c, "avenue", "ground", zones);
  main(west, junction(0), { forward: ENTRY(660), backward: DEST });
  const segments = xs.slice(0, -1).map((_, i) => main(junction(i), junction(i + 1)));
  main(junction(xs.length - 1), east, { forward: DEST, backward: ENTRY(660) });
  if (f.speed) {
    limitRoad(b, segments[1], 15);
    limitRoad(b, segments[2], 15);
  }

  xs.forEach((x, i) => {
    const north = b.node(`hN${i}`, x, -900);
    const south = b.node(`hS${i}`, x, 900);
    b.road(0, `cn${i}`, north, junction(i), "street", "ground", { forward: ENTRY(230), backward: DEST });
    b.road(0, `cs${i}`, junction(i), south, "street", "ground", { forward: DEST, backward: ENTRY(230) });
  });

  xs.forEach((_, i) => addSignal(b, junction(i), f.signal && i >= 1 && i <= 3 ? 3 : 20, 2));

  if (f.arrows) {
    leftOnlyLane(b, junction(1), junction(2));
    leftOnlyLane(b, junction(3), junction(2));
    leftOnlyLane(b, "hW", junction(0));
  }
  return { nodes: [...b.nodes.values()], edges: b.edges };
}

/**
 * Interchange site: two motorways that stop short of each other. Nothing connects them, so W traffic can't
 * reach N or E and S traffic can't reach E or N until the player builds something in the gap: an at-grade
 * junction, a roundabout, or (best) a proper grade-separated interchange with ramps.
 * Traffic enters from the west and south arms and leaves by the east and north arms.
 */
export function buildInterchangeSite(): NetworkSnapshot {
  const b = new Builder();
  const gap = 300;
  const reach = 1800;
  const wi = b.node("wi", -gap, 0);
  const ei = b.node("ei", gap, 0);
  const ni = b.node("ni", 0, -gap);
  const si = b.node("si", 0, gap);
  const w = b.node("w", -reach, 0);
  const e = b.node("e", reach, 0);
  const n = b.node("n", 0, -reach);
  const s = b.node("s", 0, reach);
  const demand = 2400;
  // Destinations demand real highway speeds, so a clogged junction fails its contracts.
  const fast: ZoneSpec = { type: "destination", targetSpeedMph: 35 };
  b.road(0, "armW", w, wi, "motorway", "ground", { forward: ENTRY(demand), backward: undefined });
  b.road(0, "armE", ei, e, "motorway", "ground", { forward: fast, backward: undefined });
  b.road(0, "armN", ni, n, "motorway", "ground", { forward: fast, backward: undefined });
  b.road(0, "armS", s, si, "motorway", "ground", { forward: ENTRY(demand), backward: undefined });
  return { nodes: [...b.nodes.values()], edges: b.edges };
}

/**
 * Clover Crossing: a cloverleaf interchange of my own design, where an east-west freeway runs at ground level under a
 * north-south one that climbs over it.
 *
 * Every left turn is a 270-degree loop (radius `R`) in its own quadrant, leaving one freeway and joining the other,
 * and every right turn is a long outer ramp that swings around the outside of the loop. The loops join each freeway
 * at the same point where the other loop leaves it, so cars entering from one loop and leaving by the next have only
 * about 2R of road to weave across. That weave is the whole puzzle.
 *
 * Each freeway is two separate one-way carriageways (like the real ones), `G` feet either side of its centreline.
 */
export function buildCloverleaf(): NetworkSnapshot {
  const b = new Builder();
  const R = 520;
  const G = 35;
  const ARM = 7 * R;
  const demand = 2600;
  const OUT_EXIT = 2.8 * R;
  const OUT_JOIN = 3.25 * R;

  // One quarter-turn about the middle, in plan (+x east, +z south): east becomes south, south becomes west...
  const rot = (k: number, x: number, z: number): [number, number] => {
    let px = x;
    let pz = z;
    for (let i = 0; i < k; i++) [px, pz] = [-pz, px];
    return [px, pz];
  };
  const key = (x: number, z: number) => `n${Math.round(x)}_${Math.round(z)}`;
  const nodeAt = (x: number, z: number) => {
    const id = key(x, z);
    if (!b.nodes.has(id)) b.node(id, Math.round(x), Math.round(z));
    return id;
  };

  // The freeways' four carriageways: east-bound at z=+G, west-bound at z=-G, north-bound at x=+G, south-bound at x=-G.
  // Each runs between its two arm ends, through every point a ramp touches it.
  type Carriage = { id: string; at: (t: number) => [number, number]; along: (x: number, z: number) => number; ascending: boolean; entryEnd: "start" | "end" };
  const carriages: Carriage[] = [
    { id: "EB", at: (t) => [t, G], along: (x) => x, ascending: true, entryEnd: "start" },
    { id: "WB", at: (t) => [t, -G], along: (x) => x, ascending: false, entryEnd: "start" },
    { id: "NB", at: (t) => [G, t], along: (_x, z) => z, ascending: false, entryEnd: "start" },
    { id: "SB", at: (t) => [-G, t], along: (_x, z) => z, ascending: true, entryEnd: "start" },
  ];

  // The loop in the south-east quarter (east-bound onto north-bound), turned to make the other three.
  const loopPts: [number, number][] = [];
  for (let deg = 15; deg < 270; deg += 15) {
    const t = (deg * Math.PI) / 180;
    loopPts.push([R + G + R * Math.sin(t), G + R - R * Math.cos(t)]);
  }
  // The outer right-turn ramp in the south-west quarter (east-bound onto south-bound), in units of R.
  const outerUnits: [number, number][] = [
    [-2.55, 0.06], [-2.38, 0.3], [-2.34, 0.8], [-2.32, 1.35], [-2.22, 1.95], [-1.95, 2.38],
    [-1.45, 2.62], [-0.95, 2.68], [-0.5, 2.78], [-0.22, 2.92], [-0.1, 2.98], [-0.03, 3.12],
  ];
  const ramp = (id: string, from: string, to: string, pts: [number, number][], mph: number) => {
    b.edges.push({
      id,
      fromNodeId: from,
      toNodeId: to,
      interiorPoints: pts.map(([x, z]) => [Math.round(x), 0, Math.round(z)] as [number, number, number]),
      roadClassId: "highway",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 12,
      speedLimitMph: mph,
    });
    b.stageOfEdge.set(id, 0);
  };
  for (let k = 0; k < 4; k++) {
    const [lx0, lz0] = rot(k, R + G, G);
    const [lx1, lz1] = rot(k, G, R + G);
    ramp(`loop${k}`, nodeAt(lx0, lz0), nodeAt(lx1, lz1), loopPts.map(([x, z]) => rot(k, x, z)), 30);
    const [ox0, oz0] = rot(k, -OUT_EXIT, G);
    const [ox1, oz1] = rot(k, -G, OUT_JOIN);
    ramp(
      `outer${k}`,
      nodeAt(ox0, oz0),
      nodeAt(ox1, oz1),
      outerUnits.map(([ux, uz]) => rot(k, ux * R, uz * R)),
      45
    );
  }

  // Lay each carriageway through its ramp junctions, climbing over the other freeway between the loop junctions.
  const humpY = 24;
  for (const c of carriages) {
    const ends = [c.at(-ARM), c.at(ARM)];
    const pts = new Map<string, [number, number]>();
    for (const [x, z] of ends) pts.set(key(x, z), [x, z]);
    for (const n of b.nodes.values()) {
      const [x, , z] = n.position;
      const [cx, cz] = c.at(0);
      const onLine = c.id === "EB" || c.id === "WB" ? Math.abs(z - cz) < 1 : Math.abs(x - cx) < 1;
      if (onLine) pts.set(n.id, [x, z]);
    }
    const ordered = [...pts.values()].sort((p, q) => (c.ascending ? 1 : -1) * (c.along(p[0], p[1]) - c.along(q[0], q[1])));
    for (let i = 0; i + 1 < ordered.length; i++) {
      const [x0, z0] = ordered[i];
      const [x1, z1] = ordered[i + 1];
      const from = nodeAt(x0, z0);
      const to = nodeAt(x1, z1);
      const isB = c.id === "NB" || c.id === "SB";
      const span = Math.min(Math.abs(c.along(x0, z0)), Math.abs(c.along(x1, z1)));
      const over = isB && Math.abs(c.along(x0, z0)) <= R + G + 1 && Math.abs(c.along(x1, z1)) <= R + G + 1 && span <= R + G + 1 && Math.sign(c.along(x0, z0)) !== Math.sign(c.along(x1, z1));
      const first = i === 0;
      const last = i === ordered.length - 2;
      const interior: [number, number, number][] = [];
      if (over) {
        // a smooth hump: ground at both loop junctions, 24 ft up where it crosses the other freeway
        const sgn = c.ascending ? 1 : -1;
        for (const [frac, h] of [[-0.62, 0.35], [-0.3, 0.8], [-0.1, 1], [0.1, 1], [0.3, 0.8], [0.62, 0.35]] as [number, number][]) {
          const along = sgn * frac * R;
          interior.push(isB ? [c.at(0)[0], humpY * h, along] : [along, humpY * h, c.at(0)[1]]);
        }
      }
      const zone = first ? ENTRY(demand) : last ? DEST : undefined;
      b.edges.push({
        id: `${c.id}${i}`,
        fromNodeId: from,
        toNodeId: to,
        interiorPoints: interior,
        roadClassId: "motorway",
        elevationLevelId: over ? "tier1" : "ground",
        lanes: 3,
        laneWidthFt: 12,
        speedLimitMph: 65,
        ...(zone ? { zone } : {}),
      });
      b.stageOfEdge.set(`${c.id}${i}`, 0);
    }
  }
  return { nodes: [...b.nodes.values()], edges: b.edges };
}
