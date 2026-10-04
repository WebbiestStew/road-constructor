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
  test(`${plan.name}: baseline holds within 12% (it is a multi-seed mean, and the small maps vary 6-11% between seeds; this checks one seed), and is reproducible`, () => {
    const a = run(plan.key);
    const b = run(plan.key);
    // The run stops at the first tick at or past 300 s, and that overshoot varies slightly with timer jitter.
    assert.ok(Math.abs(a.trips - b.trips) <= Math.max(3, a.trips * 0.01), `same seed gave ${a.trips} then ${b.trips}`);
    const drift = Math.abs(a.trips - plan.baseline) / plan.baseline;
    assert.ok(
      drift <= 0.12,
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

test("speed limits are capped by road class, but a road keeps a limit it already has", async () => {
  const { maxSpeedLimitFor } = await import("../../src/sim/roadClasses");
  assert.equal(maxSpeedLimitFor("street", 30), 40);
  assert.equal(maxSpeedLimitFor("motorway", 65), 75);
  assert.equal(maxSpeedLimitFor("street", 45), 45, "a real-city street already posted above the cap keeps it");
  assert.ok(maxSpeedLimitFor("avenue", 40) < maxSpeedLimitFor("highway", 55));
  assert.equal(maxSpeedLimitFor("motorway", 35, "tunnel"), 45, "a tunnel is capped below its class");
  assert.equal(maxSpeedLimitFor("motorway", 65, "ground"), 75);
});

test("Clover Crossing: the untouched interchange earns one star, and a second lane on the ramps reaches three", async () => {
  const { getScenarioById } = await import("../../src/sim/scenarios");
  const level = getScenarioById("clover-crossing")!;
  const base = runLevel("clover-crossing", "none").trips;
  const fixed = runLevel("clover-crossing", "ramps2").trips;
  // the level's own targets, from the untouched mean
  const stars = (moved: number) => {
    const res = level.createEvaluator()({ elapsedS: 300, completedTripsTotal: moved } as never);
    return res.stars;
  };
  assert.equal(stars(base), 1, `untouched moved ${base}`);
  assert.equal(stars(fixed), 3, `ramps widened moved ${fixed}`);
});

// ---------------------------------------------------------------------------
// Incidents, gantries and continuous-flow lefts (scripts/sim/features.ts).
// ---------------------------------------------------------------------------

function feature(arg: string): Record<string, number | string | null> {
  const out = execFileSync("npx", ["tsx", "scripts/sim/features.ts", arg], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("a stalled semi blocks the road until a wrecker comes, and sending one clears it far sooner", () => {
  const waited = feature("stall");
  const sent = feature("stall:10");
  assert.equal(waited.opened, 1, "the scripted stall should open an incident");
  assert.ok(typeof sent.clearedAtS === "number", "a dispatched wrecker should clear the stall");
  const sentAt = sent.clearedAtS as number;
  const waitedAt = (waited.clearedAtS as number | null) ?? Infinity;
  assert.ok(sentAt <= 60 + 10 + 110, `wrecker took until ${sentAt}s`);
  assert.ok(waitedAt > sentAt, `waiting (${waitedAt}s) should be slower than dispatching (${sentAt}s)`);
});

test("closing a lane at a gantry keeps drivers out of it, and an advisory slows the road", () => {
  const open = feature("none");
  const closed = feature("closure");
  assert.ok((open.share as number) > 0.2, `lane 1 carries only ${open.share} when open`);
  assert.ok((closed.share as number) < 0.1, `lane 1 still carries ${closed.share} when closed`);
  const slow = feature("vsl:35");
  assert.ok((slow.avgMph as number) < (open.avgMph as number), `35 mph advisory: ${slow.avgMph} vs ${open.avgMph}`);
});

test("Continuous Flow: yielding left turns cost throughput, and displaced lefts win it back", () => {
  const seeds = [1337, 22];
  const mean = (mode: string) => seeds.reduce((sum, s) => sum + (feature(`cross:${mode}:${s}`).trips as number), 0) / seeds.length;
  const yielding = mean("yield");
  const displaced = mean("cfi");
  assert.ok(displaced > yielding * 1.08, `displaced ${displaced} vs yielding ${yielding}`);
});
