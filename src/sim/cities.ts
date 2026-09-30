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
const REACH = 1500;

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
 *  - Speed limits: the stretch between the second and third lights is posted 15 mph.
 *  - Signals: the second and fourth lights flip every 4 seconds.
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
  if (f.speed) limitRoad(b, segments[1], 15);

  xs.forEach((x, i) => {
    const north = b.node(`hN${i}`, x, -900);
    const south = b.node(`hS${i}`, x, 900);
    b.road(0, `cn${i}`, north, junction(i), "street", "ground", { forward: ENTRY(230), backward: DEST });
    b.road(0, `cs${i}`, junction(i), south, "street", "ground", { forward: DEST, backward: ENTRY(230) });
  });

  xs.forEach((_, i) => addSignal(b, junction(i), f.signal && (i === 1 || i === 3) ? 4 : 20, 2));

  if (f.arrows) {
    leftOnlyLane(b, junction(1), junction(2));
    leftOnlyLane(b, junction(3), junction(2));
    leftOnlyLane(b, "hW", junction(0));
  }
  return { nodes: [...b.nodes.values()], edges: b.edges };
}

/**
 * Old Town: a tight three-by-three grid of narrow one-lane streets. Every corner has a traffic light.
 *  - Signals: the four corner lights flip every 3 seconds, so they spend most of their time on clearance.
 * Less is more here — some of these lights do more harm than good, so dropping them to priority helps.
 */
export function buildOldTown(spec: FaultSpec = true): NetworkSnapshot {
  const f = faultsOf(spec);
  const b = new Builder();
  const gap = 300;
  const coords = [-gap, 0, gap];
  const name = (i: number, j: number) => `o${i}${j}`;
  coords.forEach((x, i) => coords.forEach((z, j) => b.node(name(i, j), x, z)));

  let seq = 0;
  // Horizontal and vertical streets between neighbouring corners.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i < 2) {
        b.road(0, `oh${seq++}`, name(i, j), name(i + 1, j), "street");
      }
      if (j < 2) b.road(0, `ov${seq++}`, name(i, j), name(i, j + 1), "street");
    }
  }
  // Streets out of town from each outer corner side.
  const reach = 1100;
  const demand = 630;
  coords.forEach((c, k) => {
    const n = b.node(`on${k}`, c, -reach);
    b.road(0, `on${k}`, n, name(k, 0), "street", "ground", { forward: ENTRY(demand), backward: DEST });
    const s = b.node(`os${k}`, c, reach);
    b.road(0, `os${k}`, name(k, 2), s, "street", "ground", { forward: DEST, backward: ENTRY(demand) });
    const w = b.node(`ow${k}`, -reach, c);
    b.road(0, `ow${k}`, w, name(0, k), "street", "ground", { forward: ENTRY(demand), backward: DEST });
    const e = b.node(`oe${k}`, reach, c);
    b.road(0, `oe${k}`, name(2, k), e, "street", "ground", { forward: DEST, backward: ENTRY(demand) });
  });

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const id = name(i, j);
      addSignal(b, id, f.signal && (id === "o00" || id === "o22" || id === "o02" || id === "o20") ? 3 : 20, 2);
    }
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
