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
  test(`${plan.name}: baseline holds within 8% (it is a multi-seed mean; this checks one seed), and is reproducible`, () => {
    const a = run(plan.key);
    const b = run(plan.key);
    // The run stops at the first tick at or past 300 s, and that overshoot varies slightly with timer jitter.
    assert.ok(Math.abs(a.trips - b.trips) <= Math.max(3, a.trips * 0.01), `same seed gave ${a.trips} then ${b.trips}`);
    const drift = Math.abs(a.trips - plan.baseline) / plan.baseline;
    assert.ok(
      drift <= 0.08,
      `${plan.key}: moved ${a.trips}, expected ~${plan.baseline} (drift ${(drift * 100).toFixed(1)}%). If a sim change is intended, re-measure and update REAL_PLANS.`
    );
  });
}

test("a level can be improved: adding lanes beats the three-star target in Houston", () => {
  const plan = REAL_PLANS.find((p) => p.key === "houston")!;
  const better = run("houston", "lanes5");
  assert.ok(better.trips >= Math.ceil(plan.baseline * 1.12), `only ${better.trips} vs target ${Math.ceil(plan.baseline * 1.12)}`);
});

// ---------------------------------------------------------------------------
// The levels that score something other than vehicles moved: each needs a real route to its stars.
// ---------------------------------------------------------------------------

function runLevel(id: string, variant: string): { trips: number; people: number; incidents: number; amb: string; crashes?: string } {
  const out = execFileSync("npx", ["tsx", "scripts/sim/level.ts", id, variant], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("Code Three: reserving a bus lane as a fast lane gets all four ambulances through quickly", () => {
  const r = runLevel("code-three", "bus");
  const [done, rest] = r.amb.split(" x");
  assert.equal(done, "4/4", `only ${done} arrived`);
  assert.ok(Number(rest) <= 1.6, `average ${rest}x an empty road, needs <= 1.6`);
});

test("School Run: crossings on the school blocks stop anyone stepping into traffic", () => {
  const r = runLevel("school-run", "fixed,cross");
  assert.equal(r.incidents, 0);
});

test("First Shift: the three fixes together reach the three-star pace", () => {
  const r = runLevel("first-shift", "fixed,cross");
  assert.equal(r.incidents, 0);
  assert.ok(r.trips >= 236 * 0.85, `only ${r.trips} moved`);
});

test("Transit Street: bus lanes move more people than leaving the street alone", () => {
  const none = runLevel("transit-street", "none");
  const bus = runLevel("transit-street", "bus");
  assert.ok(bus.people > none.people * 1.08, `${bus.people} vs ${none.people}`);
});

test("Pile-Up: a fixed city clears every crash within the three-star time, an untouched one does not", () => {
  const parse = (r: { crashes?: string }) => {
    const m = /^(\d+)\/(\d+) avg (\d+|-)s$/.exec(r.crashes ?? "");
    return { cleared: Number(m?.[1] ?? 0), happened: Number(m?.[2] ?? 0), avg: m?.[3] === "-" ? Infinity : Number(m?.[3] ?? Infinity) };
  };
  const fixed = parse(runLevel("pile-up", "fixed") as { crashes?: string });
  assert.equal(fixed.cleared, 4);
  assert.ok(fixed.avg <= 75, `fixed city averaged ${fixed.avg}s`);
  const none = parse(runLevel("pile-up", "none") as { crashes?: string });
  assert.ok(none.cleared < 4 || none.avg > 75, "an untouched city should not earn three stars");
});
