// Headless checks for incidents and wreckers: npx tsx scripts/sim/features.ts <case>
import { getScenarioById, REAL_PLANS } from "../../src/sim/scenarios";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import type { ScriptedEvent } from "../../src/sim/types";
import { assembleNetwork, computeRoute, hasGantry } from "../../src/sim/network";
import { cloneNetwork, createSim, HARNESS_SPEED } from "./harness";
(globalThis as unknown as { __simDebug: Record<string, unknown> }).__simDebug = {};

const [which = "incidents"] = process.argv.slice(2);
const g = globalThis as unknown as { __simLast: unknown };

async function incidentCase(kind: "stall" | "debris" | "fender", dispatchAfterS: number | null) {
  const level = getScenarioById("clover-crossing")!;
  const sim = await createSim();
  sim.load(cloneNetwork(level.startingNetwork), 1337, HARNESS_SPEED);
  // Both the stall and the wrecker's dispatch are scheduled on the sim's own clock, so the run does not depend on how fast the machine is.
  const events: ScriptedEvent[] = [{ atS: 60, kind }];
  if (dispatchAfterS !== null) events.push({ atS: 60 + dispatchAfterS, kind: "dispatchWrecker" });
  sim.send({ type: "scheduleEvents", events });
  let t = await sim.runUntil(75);
  const opened = t.incidents.length;
  let clearedAt: number | null = null;
  const timeline: string[] = [];
  for (let s = 75; s <= 420; s += 5) {
    t = await sim.runUntil(s);
    if (t.incidents.length === 0 && clearedAt === null && opened > 0) clearedAt = s;
    if (s % 30 === 0) timeline.push(`${s}:${t.incidents.map((i) => `${i.kind}/${i.wrecker}`).join(",") || "-"}`);
  }
  console.log(JSON.stringify({ kind, dispatchAfterS, opened, clearedAtS: clearedAt, timeline: timeline.join(" ") }));
  process.exit(0);
}

/** Closes a lane on every gantry road of the cloverleaf, or posts an advisory, and looks at who is in the lane / how fast they go. */
async function gantryCase(mode: "none" | "closure" | "vsl", vsl = 35) {
  const level = getScenarioById("clover-crossing")!;
  const network = cloneNetwork(level.startingNetwork);
  const assembled = assembleNetwork(network);
  const gantryEdges = new Set(assembled.edges.filter((e) => hasGantry(e) && e.lanes >= 3).map((e) => e.id));
  for (const e of network.edges) {
    if (!gantryEdges.has(e.id)) continue;
    if (mode === "closure") e.closedLanes = [1];
    if (mode === "vsl") e.vslMph = vsl;
  }
  const sim = await createSim();
  sim.load(network, 1337, HARNESS_SPEED);
  const dbg = (globalThis as unknown as { __simDebug: { state: () => { vehicles: Map<number, { edgeId: string; laneIndex: number; distanceAlongEdge: number; speed: number }>; network: { edgesById: Map<string, { length: number }> } } } }).__simDebug;
  let inClosed = 0;
  let samples = 0;
  let speedSum = 0;
  let speedN = 0;
  for (let t = 120; t <= 300; t += 2) {
    const tick = await sim.runUntil(t);
    const st = dbg.state();
    for (const v of st.vehicles.values()) {
      if (!gantryEdges.has(v.edgeId)) continue;
      const len = st.network.edgesById.get(v.edgeId)!.length;
      if (v.distanceAlongEdge < len * 0.5) continue;
      samples++;
      if (v.laneIndex === 1) inClosed++;
      speedSum += v.speed;
      speedN++;
    }
    void tick;
  }
  const end = await sim.runUntil(300);
  console.log(JSON.stringify({ mode, vsl, trips: end.trips, gantryRoads: gantryEdges.size, vehiclesPastGantry: samples, inLane1: inClosed, share: +(inClosed / Math.max(1, samples)).toFixed(3), avgMph: +(speedSum / Math.max(1, speedN) * 0.6818).toFixed(1) }));
  process.exit(0);
}

/** Left turns that yield to oncoming traffic, with and without displaced lefts on every approach that can have one. */
async function cfiCase(key: string, mode: "off" | "yield" | "cfi", seed = 1337) {
  const network = cloneNetwork(REAL_CITY_DATA[key].network);
  const assembled = assembleNetwork(network);
  const signals = new Set(network.nodes.filter((n) => n.control?.type === "signal").map((n) => n.id));
  let displaced = 0;
  if (mode === "cfi") {
    const byId = new Map(network.edges.map((e) => [e.id, e]));
    for (const e of assembled.edges) {
      if (!signals.has(e.toNodeId) || e.length < 380) continue;
      if (![...e.nextMoves.values()].includes("left")) continue;
      byId.get(e.id)!.displacedLeft = true;
      displaced++;
    }
  }
  const sim = await createSim();
  sim.send({ type: "setLeftTurnsYield", enabled: mode !== "off" });
  sim.load(network, seed, HARNESS_SPEED);
  const end = await sim.runUntil(REAL_PLANS.find((p) => p.key === key)?.durationS ?? 300);
  console.log(JSON.stringify({ key, mode, seed, signals: signals.size, displaced, trips: end.trips, mph: Math.round(end.avgMph) }));
  process.exit(0);
}

/** The Continuous Flow level: yielding lefts, with and without displaced lefts on all four approaches. */
async function crossingCase(mode: "off" | "yield" | "cfi" | "cfi2" | "prot" | "split", seed = 1337) {
  const level = getScenarioById("continuous-flow")!;
  const network = cloneNetwork(level.startingNetwork);
  let displaced = 0;
  for (const e of network.edges) {
    const onMajor = e.id === "aWf" || e.id === "aEf";
    if ((mode === "cfi" && onMajor) || mode === "cfi2") {
      if (e.toNodeId === "J") {
        e.displacedLeft = true;
        displaced++;
      }
    }
  }
  for (const n of network.nodes) if (n.control?.type === "signal" && (mode === "prot" || mode === "split")) n.control.mode = mode === "prot" ? "protected" : "split";
  const sim = await createSim();
  sim.send({ type: "setLeftTurnsYield", enabled: mode !== "off" });
  sim.load(network, seed, HARNESS_SPEED);
  const end = await sim.runUntil(300);
  const dbg = (globalThis as { __simDebug?: { state?: () => { leftStats: () => { served: number; waitS: number } } } }).__simDebug?.state?.().leftStats();
  console.log(JSON.stringify({ lefts: dbg?.served, avgWaitS: dbg ? Math.round(dbg.waitS / Math.max(1, dbg.served)) : 0, level: "continuous-flow", mode, seed, displaced, trips: end.trips, mph: Math.round(end.avgMph) }));
  process.exit(0);
}

/** The carpool and express lanes on every freeway road with three lanes or more in the cloverleaf: who ends up in the left lane, and the toll. */
async function laneCase(kind: "none" | "hov" | "express") {
  const level = getScenarioById("clover-crossing")!;
  const network = cloneNetwork(level.startingNetwork);
  const assembled = assembleNetwork(network);
  const targets = new Set(assembled.edges.filter((e) => e.isFreeway && e.lanes >= 3 && e.length >= 500).map((e) => e.id));
  if (kind !== "none") for (const e of network.edges) if (targets.has(e.id)) e.reservedLane = kind;
  const sim = await createSim();
  g.__simLast = null;
  sim.load(network, 1337, HARNESS_SPEED);
  const dbg = (globalThis as unknown as { __simDebug: { state: () => { vehicles: Map<number, { id: number; kind: string; edgeId: string; laneIndex: number; distanceAlongEdge: number }>; network: { edgesById: Map<string, { length: number }> } } } }).__simDebug;
  const carpool = (id: number) => id > 0 && (Math.imul(id, 2654435761) >>> 0) % 100 < 20;
  let inLeft = 0;
  let wrong = 0;
  let samples = 0;
  for (let t = 90; t <= 300; t += 2) {
    await sim.runUntil(t);
    const st = dbg.state();
    for (const v of st.vehicles.values()) {
      if (!targets.has(v.edgeId)) continue;
      const len = st.network.edgesById.get(v.edgeId)!.length;
      // away from the ends, where a driver may cross the lane to make a turn
      if (v.distanceAlongEdge < 120 || v.distanceAlongEdge > len - 160) continue;
      samples++;
      if (v.laneIndex !== 0) continue;
      inLeft++;
      const allowed = kind === "hov" ? v.kind === "bus" || (v.kind === "car" && carpool(v.id)) : kind === "express" ? v.kind !== "truck" && v.kind !== "bike" : true;
      if (!allowed) wrong++;
    }
  }
  const end = await sim.runUntil(300);
  console.log(JSON.stringify({ lanes: kind, roads: targets.size, samples, inLeftLane: inLeft, notAllowedInLeft: wrong, trips: end.trips, expressS: Math.round((g.__simLast as { expressVehicleS?: number } | null)?.expressVehicleS ?? 0) }));
  process.exit(0);
}

/** Two bus lines through Transit Street with stops on every long road: how evenly the buses are spaced, with and without holding at stops. */
async function transitCase(hold: boolean, lines: 1 | 2 = 1) {
  const level = getScenarioById("transit-street")!;
  const network = cloneNetwork(level.startingNetwork);
  const assembled = assembleNetwork(network);
  const entries = assembled.edges.filter((e) => e.zone?.type === "entry");
  const dests = assembled.edges.filter((e) => e.zone?.type === "destination");
  const routes: string[][] = [];
  for (const en of entries) {
    for (const d of dests) {
      const r = computeRoute(assembled, en.id, d.id);
      if (r && r.length >= 4) routes.push(r);
    }
  }
  routes.sort((a, b) => b.length - a.length);
  const picked = [routes[0], routes.find((r) => r.some((id) => !routes[0].includes(id)) && r.some((id) => routes[0].includes(id))) ?? routes[1]].slice(0, lines);
  const stopEdges = new Set(picked.flat());
  for (const e of network.edges) {
    const a = assembled.edgesById.get(e.id)!;
    if (stopEdges.has(e.id) && a.length >= 160) e.busStop = true;
  }
  const sim = await createSim();
  sim.send({ type: "setTrafficMix", bus: 0.16, bike: 0 });
  sim.send({ type: "setTransit", lines: picked.map((r, i) => ({ id: `L${i}`, name: `Line ${i + 1}`, edgeIds: r, headwayS: 28, color: "#f00", hold })) });
  sim.load(network, 1337, HARNESS_SPEED);
  const end = await sim.runUntil(300);
  const t = (g.__simLast as { transit?: Record<string, number>; peopleMovedTotal?: number } | null) ?? {};
  console.log(JSON.stringify({ lines, hold, trips: end.trips, people: Math.round(end.people), ...t.transit, headwayMeanS: Math.round(t.transit?.headwayMeanS ?? 0), headwayCv: +(t.transit?.headwayCv ?? 0).toFixed(2) }));
  process.exit(0);
}

/** Takes the wheel of a car at 30 s, floors it, asks for lane changes, and reports how the drive went. */
async function driveCase(mode: "flat" | "careful") {
  const level = getScenarioById("harbor-drive")!;
  const sim = await createSim();
  sim.load(cloneNetwork(level.startingNetwork), 1337, HARNESS_SPEED);
  const dbg = (globalThis as unknown as { __simDebug: { state: () => { vehicles: Map<number, { id: number; kind: string; routeEdgeIds: string[]; routeIndex: number; distanceAlongEdge: number; speed: number }> } } }).__simDebug;
  await sim.runUntil(30);
  const pick = [...dbg.state().vehicles.values()].filter((v) => v.kind === "car" && v.routeEdgeIds.length - v.routeIndex >= 3).sort((a, b) => b.routeEdgeIds.length - b.routeIndex - (a.routeEdgeIds.length - a.routeIndex))[0];
  if (!pick) throw new Error("no car to drive");
  sim.send({ type: "drive", action: "take", id: pick.id });
  sim.send({ type: "driveInput", accel: mode === "flat" ? 1 : 0 });
  const views: string[] = [];
  let result: Record<string, unknown> | null = null;
  for (let t = 32; t <= 260 && !result; t += 2) {
    await sim.runUntil(t);
    const last = g.__simLast as { drive?: Record<string, unknown> | null; driveResult?: Record<string, unknown> | null };
    if (t % 10 === 0 && last.drive) views.push(`${t}:${Math.round(last.drive.speedMph as number)}/${last.drive.limitMph}mph lane${last.drive.laneIndex}/${last.drive.lanes} next=${last.drive.nextMove}`);
    if (t === 40) sim.send({ type: "driveInput", lane: 1 });
    if (t === 60) sim.send({ type: "driveInput", lane: -1 });
    if (last.driveResult) result = last.driveResult;
  }
  console.log(JSON.stringify({ mode, car: pick.id, views: views.join(" | "), result }));
  process.exit(0);
}

/** Left turns banned on every road that ends at a signal in Midtown: nobody turns left, and the city still works. */
async function banCase(turn: "none" | "left") {
  const level = getScenarioById("midtown")!;
  const network = cloneNetwork(level.startingNetwork);
  if (turn === "left") for (const e of network.edges) e.bannedTurns = ["left"];
  const assembled = assembleNetwork(network);
  let leftExits = 0;
  for (const e of assembled.edges) for (const m of e.nextMoves.values()) if (m === "left") leftExits++;
  const sim = await createSim();
  sim.load(network, 1337, HARNESS_SPEED);
  const end = await sim.runUntil(300);
  console.log(JSON.stringify({ ban: turn, leftExitsInGraph: leftExits, trips: end.trips }));
  process.exit(0);
}

async function main() {
  if (which.startsWith("drive:")) return driveCase(which.split(":")[1] as "flat" | "careful");
  if (which === "hov" || which === "express" || which === "lanes-none") return laneCase(which === "lanes-none" ? "none" : which);
  if (which.startsWith("transit:")) return transitCase(which.split(":")[1] === "hold", which.split(":")[2] === "2" ? 2 : 1);
  if (which === "ban:left" || which === "ban:none") return banCase(which.split(":")[1] as "left" | "none");
  if (which.startsWith("cross:")) {
    const [, mode, seed] = which.split(":");
    return crossingCase(mode as "off" | "yield" | "cfi" | "cfi2" | "prot" | "split", seed ? Number(seed) : 1337);
  }
  if (which.startsWith("cfi:")) {
    const [, key, mode, seed] = which.split(":");
    return cfiCase(key, mode as "off" | "yield" | "cfi", seed ? Number(seed) : 1337);
  }
  if (which === "none" || which === "closure") return gantryCase(which);
  if (which.startsWith("vsl")) return gantryCase("vsl", Number(which.split(":")[1] ?? 35));
  const [kind, dispatch] = which.split(":");
  await incidentCase(kind as "stall" | "debris" | "fender", dispatch ? Number(dispatch) : null);
}
void main();
