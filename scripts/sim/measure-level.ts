// Measures a city the way the in-game "Publish" button does: npx tsx scripts/sim/measure-level.ts <network.json> [--traffic-mix bus,bike]
// The file is a network export from the game ({ network: { nodes, edges }, ... } or a bare { nodes, edges }).
// Prints the unchanged city's vehicles moved over three seeds (each in its own process: the worker is a singleton) and the star lines.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { cloneNetwork, createSim, HARNESS_SPEED } from "./harness";
import type { NetworkSnapshot } from "../../src/sim/types";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const seedFlag = args.indexOf("--seed");
const mixFlag = args.indexOf("--traffic-mix");
const mix = mixFlag >= 0 ? args[mixFlag + 1].split(",").map(Number) : [0, 0];
if (!file) throw new Error("usage: measure-level.ts <network.json> [--traffic-mix bus,bike]");

function readNetwork(): NetworkSnapshot {
  const raw = JSON.parse(fs.readFileSync(file!, "utf8"));
  return (raw.network ?? raw) as NetworkSnapshot;
}

async function one(seed: number) {
  const sim = await createSim();
  const g = globalThis as unknown as { postMessage: (m: unknown) => void };
  let last: { completedTripsTotal: number; tripDelayTotalS: number; tripFreeFlowTotalS: number; queuePeakFt: number } | null = null;
  const prev = g.postMessage;
  g.postMessage = (m: unknown) => {
    if ((m as { type: string }).type === "tick") last = m as typeof last;
    prev(m);
  };
  sim.send({ type: "setTrafficMix", bus: mix[0], bike: mix[1] });
  sim.load(cloneNetwork(readNetwork()), seed, HARNESS_SPEED);
  await sim.runUntil(300);
  console.log(JSON.stringify({ trips: last?.completedTripsTotal ?? 0, delayShare: last && last.tripFreeFlowTotalS > 0 ? last.tripDelayTotalS / last.tripFreeFlowTotalS : null, queueFt: last?.queuePeakFt ?? 0 }));
  process.exit(0);
}

if (seedFlag >= 0) {
  void one(Number(args[seedFlag + 1]));
} else {
  const results = [1337, 2024, 77].map((seed) => {
    const out = execFileSync("npx", ["tsx", "scripts/sim/measure-level.ts", file, "--seed", String(seed), ...(mixFlag >= 0 ? ["--traffic-mix", args[mixFlag + 1]] : [])], { encoding: "utf8" });
    return JSON.parse(out.trim().split("\n").pop()!) as { trips: number; delayShare: number | null; queueFt: number };
  });
  const trips = results.map((r) => r.trips);
  const baseline = Math.round(trips.reduce((a, b) => a + b, 0) / trips.length);
  const delays = results.map((r) => r.delayShare).filter((d): d is number => d !== null);
  console.log(
    JSON.stringify({
      baseline,
      trips,
      twoStars: Math.ceil(baseline * 1.07),
      threeStars: Math.ceil(baseline * 1.12),
      delayShare: delays.length ? +(delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(3) : null,
      queueFt: Math.round(results.reduce((a, b) => a + b.queueFt, 0) / results.length),
    })
  );
}
