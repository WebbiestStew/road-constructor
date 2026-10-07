// Headless checks for incidents and wreckers: npx tsx scripts/sim/features.ts <case>
import { getScenarioById, REAL_PLANS } from "../../src/sim/scenarios";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import type { ScriptedEvent } from "../../src/sim/types";
import { assembleNetwork, hasGantry } from "../../src/sim/network";
import { cloneNetwork, createSim, HARNESS_SPEED } from "./harness";
(globalThis as unknown as { __simDebug: Record<string, unknown> }).__simDebug = {};

const [which = "incidents"] = process.argv.slice(2);

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

async function main() {
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
