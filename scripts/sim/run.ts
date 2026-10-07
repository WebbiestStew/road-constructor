// Child-process entry: loads one real city (optionally with a variant applied), runs 300 sim-seconds, prints JSON.
// The worker is a singleton per process, which is why the tests shell out to this instead of running in-process.
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import fs from "node:fs";
import { REAL_PLANS } from "../../src/sim/scenarios";
import { cloneNetwork, createSim, HARNESS_SPEED } from "./harness";

const [key, variant = "none", seed = "1337"] = process.argv.slice(2);

async function main() {
  const network = cloneNetwork(REAL_CITY_DATA[key].network);
  if (variant === "lanes") {
    for (const e of network.edges) if (!e.isRoundaboutRing && e.lanes < 4) e.lanes += 1;
  }
  // Combinable variants a player could do: lanesN (one lane added to every road below N lanes), speed (+10 mph), sig (signals re-timed).
  for (const v of variant.split(",")) {
    const m = /^lanes(\d)$/.exec(v);
    if (m) for (const e of network.edges) if (!e.isRoundaboutRing && e.lanes < Number(m[1])) e.lanes += 1;
    if (v === "plan") {
      const widen = new Set<string>(JSON.parse(fs.readFileSync(`/tmp/plan-${key}.json`, "utf8")).widen);
      for (const e of network.edges) if (widen.has(e.id)) e.lanes += 1;
    }
    if (v === "speedcap") {
      // A player raising every limit as far as the class allows: design speed + 10 mph, never below what is there.
      const cap: Record<string, number> = { lane: 45, street: 40, avenue: 45, highway: 65, motorway: 75 };
      for (const e of network.edges) e.speedLimitMph = Math.max(e.speedLimitMph, e.elevationLevelId === "tunnel" ? Math.min(45, cap[e.roadClassId] ?? 45) : (cap[e.roadClassId] ?? e.speedLimitMph));
    }
    if (v === "speed75") for (const e of network.edges) e.speedLimitMph = 75;
    if (v === "speed") for (const e of network.edges) e.speedLimitMph = Math.min(75, e.speedLimitMph + 10);
    if (v === "sig") {
      for (const n of network.nodes) {
        if (n.control?.type === "signal") n.control = { ...n.control, greenDurationS: 30, allRedDurationS: 1 };
      }
    }
  }
  const sim = await createSim();
  const g = globalThis as unknown as { postMessage: (m: any) => void };
  const prevPost = g.postMessage;
  let lastTick: any = null;
  g.postMessage = (m: any) => {
    if (m.type === "tick") lastTick = m;
    prevPost(m);
  };
  sim.load(network, Number(seed), HARNESS_SPEED);
  const r = await sim.runUntil(REAL_PLANS.find((p) => p.key === key)?.durationS ?? 300);
  console.log(JSON.stringify({ trips: r.trips, mph: r.avgMph, jams: r.problems.length, delayShare: r.freeFlowS > 0 ? +(r.delayS / r.freeFlowS).toFixed(3) : null, queueFt: r.queuePeakFt, spawned: lastTick?.spawnedTotal, active: lastTick?.activeCount }));
  process.exit(0);
}
void main();
