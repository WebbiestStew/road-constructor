// Regression checks for the simulation and the real-city levels. Run with `npm run test:sim` (a few minutes).
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { REAL_PLANS } from "../../src/sim/scenarios";
import { assembleNetwork, computeRoute } from "../../src/sim/network";

function run(key: string, variant = "none", seed = 1337): { trips: number; mph: number; jams: number } {
  const out = execFileSync("npx", ["tsx", "scripts/sim/run.ts", key, variant, String(seed)], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}

for (const plan of REAL_PLANS) {
  test(`${plan.name}: every entry can reach a destination`, () => {
    const net = assembleNetwork(REAL_CITY_DATA[plan.key].network);
    const entries = net.edges.filter((e) => e.zone?.type === "entry");
    const dests = net.edges.filter((e) => e.zone?.type === "destination");
    assert.ok(entries.length > 0 && dests.length > 0, "needs entries and destinations");
    for (const en of entries) {
      assert.ok(dests.some((d) => computeRoute(net, en.id, d.id)), `${en.id} reaches no destination`);
    }
  });
}

for (const plan of REAL_PLANS) {
  test(`${plan.name}: baseline holds within 6%, and is reproducible`, () => {
    const a = run(plan.key);
    const b = run(plan.key);
    // The run stops at the first tick at or past 300 s, and that overshoot varies slightly with timer jitter.
    assert.ok(Math.abs(a.trips - b.trips) <= Math.max(3, a.trips * 0.01), `same seed gave ${a.trips} then ${b.trips}`);
    const drift = Math.abs(a.trips - plan.baseline) / plan.baseline;
    assert.ok(
      drift <= 0.06,
      `${plan.key}: moved ${a.trips}, expected ~${plan.baseline} (drift ${(drift * 100).toFixed(1)}%). If a sim change is intended, re-measure and update REAL_PLANS.`
    );
  });
}

test("a level can be improved: adding lanes beats the three-star target in Houston", () => {
  const plan = REAL_PLANS.find((p) => p.key === "houston")!;
  const better = run("houston", "lanes");
  assert.ok(better.trips >= Math.ceil(plan.baseline * 1.12), `only ${better.trips} vs target ${Math.ceil(plan.baseline * 1.12)}`);
});
