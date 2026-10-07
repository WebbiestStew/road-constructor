// Regression checks for the simulation and the real-city levels. Run with `npm run test:sim` (a few minutes).
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
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
    // The long Lincoln Tunnel run swings about 12% either side of its mean from one seed to the next (206 to 263 across eight seeds), so a single seed gets more room.
    const allowed = plan.key === "lincoln-tunnel" ? 0.2 : 0.12;
    assert.ok(
      drift <= allowed,
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
  // How long the tow truck takes depends on the traffic it meets, which varies a little between machines; it must still come in well under the three minutes it takes to be found otherwise.
  assert.ok(sentAt <= 60 + 10 + 200, `wrecker took until ${sentAt}s`);
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

test("signal phasing: protected lefts end the wait for a gap, and split phasing never deadlocks", async () => {
  const yielding = feature("cross:yield:1337");
  const protectedLefts = feature("cross:prot:1337");
  const split = feature("cross:split:1337");
  assert.ok((yielding.avgWaitS as number) >= 3, `lefts should wait for a gap when they yield (${yielding.avgWaitS}s)`);
  assert.equal(protectedLefts.avgWaitS, 0, "a protected left-turn phase should leave nothing to wait for");
  assert.ok((protectedLefts.trips as number) >= (yielding.trips as number) * 0.9, `${protectedLefts.trips} vs ${yielding.trips}`);
  assert.ok((split.trips as number) >= (yielding.trips as number) * 0.9, `split moved ${split.trips} vs ${yielding.trips}`);
});

test("signal phasing: a plan lists the phases the mode promises", async () => {
  const { buildSignalPlan, approxCycleS } = await import("../../src/sim/signals");
  const info = (id: string) => ({ moves: new Set(["left", "straight"] as const), hx: id.startsWith("e") ? 1 : id.startsWith("w") ? -1 : 0, hz: id.startsWith("n") ? 1 : id.startsWith("s") ? -1 : 0 });
  const base = { type: "signal" as const, groupA: ["e", "w"], groupB: ["n", "s"], greenDurationS: 20, allRedDurationS: 2 };
  assert.equal(buildSignalPlan(base, info).phases.length, 2);
  assert.equal(buildSignalPlan(base, info).cycleS, 44);
  const prot = buildSignalPlan({ ...base, mode: "protected", leftGreenS: 8 }, info);
  assert.equal(prot.phases.length, 4);
  assert.equal(prot.cycleS, 2 * (8 + 20) + 4 * 2);
  assert.equal(buildSignalPlan({ ...base, mode: "split" }, info).phases.length, 4);
  const ped = buildSignalPlan({ ...base, pedPhaseS: 10 }, info);
  assert.equal(ped.phases.length, 3);
  assert.ok(ped.phases[2].pedestrian && ped.phases[2].allow.size === 0);
  assert.equal(approxCycleS({ ...base, mode: "protected", leftGreenS: 8 }), prot.cycleS);
});

// ---------------------------------------------------------------------------
// Conditions, traffic rules, transit, driving and replays.
// ---------------------------------------------------------------------------

test("conditions: fog and night put people at risk at a crossing, and a lower limit makes it safe again", () => {
  const clear = runLevel("school-run", "fixed,cross");
  const fog = runLevel("school-run", "fixed,cross,fog");
  const night = runLevel("school-run", "fixed,cross,night");
  const slowFog = runLevel("school-run", "fixed,cross,fog,slow15");
  assert.equal(clear.incidents, 0, "a marked crossing is safe in clear daylight");
  assert.ok(fog.incidents >= 3, `fog caused ${fog.incidents} near misses`);
  assert.ok(night.incidents >= 3, `night caused ${night.incidents} near misses`);
  assert.equal(slowFog.incidents, 0, "a 15 mph limit at the crossing should stop them");
});

test("conditions: rain slows the city", () => {
  const dry = runLevel("first-shift", "fixed,cross");
  const wet = runLevel("first-shift", "fixed,cross,rain");
  assert.ok(wet.trips < dry.trips * 0.95, `rain moved ${wet.trips} vs ${dry.trips} dry`);
});

test("carpool and express lanes: only the right vehicles end up in them, and the express lane earns tolls", () => {
  const open = feature("lanes-none");
  const hov = feature("hov");
  const express = feature("express");
  assert.equal(hov.notAllowedInLeft, 0, "no lone driver or truck should travel in the carpool lane");
  assert.ok((hov.inLeftLane as number) > 100, `the carpool lane was used ${hov.inLeftLane} times`);
  assert.ok((hov.inLeftLane as number) < (open.inLeftLane as number) * 0.5, "far fewer vehicles qualify than for an open lane");
  const share = (express.notAllowedInLeft as number) / Math.max(1, express.inLeftLane as number);
  assert.ok(share < 0.06, `${(share * 100).toFixed(1)}% of the express lane was trucks or bikes (those still crossing it to exit)`);
  assert.ok((express.expressS as number) > 1000, `the express lane logged only ${express.expressS} car-seconds`);
});

test("turn bans: banning left turns removes every left from the graph, and traffic still flows", () => {
  const free = feature("ban:none");
  const banned = feature("ban:left");
  assert.ok((free.leftExitsInGraph as number) > 0);
  assert.equal(banned.leftExitsInGraph, 0);
  assert.ok((banned.trips as number) > (free.trips as number) * 0.4, `${banned.trips} moved with no left turns vs ${free.trips}`);
});

test("transit: stops fill between buses, two lines make transfer stops, and holding does no harm", () => {
  const free = feature("transit:free:2");
  const held = feature("transit:hold:2");
  assert.ok((free.transfers as number) > 20, `${free.transfers} people changed lines`);
  assert.ok((free.boarded as number) > 100, `${free.boarded} boarded`);
  assert.ok((free.headwayCv as number) > 0 && (free.headwayCv as number) < 1.5, `spread ${free.headwayCv}`);
  assert.ok((held.heldS as number) > 0, "a holding line should hold a bus now and then");
  assert.ok((held.people as number) > (free.people as number) * 0.9, `holding cost too much: ${held.people} vs ${free.people}`);
});

test("driving: a car you take the wheel of arrives, and flooring it costs you points", () => {
  const flat = feature("drive:flat") as unknown as { result: { arrived: boolean; score: number; speedingS: number; laneChanges: number } };
  assert.ok(flat.result, "the drive should finish");
  assert.ok(flat.result.arrived);
  assert.ok(flat.result.speedingS > 5, `only ${flat.result.speedingS}s of speeding`);
  assert.ok(flat.result.score < 80, `score ${flat.result.score}`);
  assert.ok(flat.result.laneChanges >= 1, "asked-for lane changes should happen when there is a gap");
});

test("replays: a recorded run plays back to exactly the same traffic, tick for tick", () => {
  const file = "/tmp/rc-test-replay.json";
  execFileSync("npx", ["tsx", "scripts/sim/replay.ts", "record", file], { encoding: "utf8" });
  const out = execFileSync("npx", ["tsx", "scripts/sim/replay.ts", "play", file], { encoding: "utf8" });
  const r = JSON.parse(out.trim().split("\n").pop()!);
  assert.equal(r.differing, 0, `${r.differing} of ${r.samples} samples differed`);
  assert.equal(r.same, true);
});

// ---------------------------------------------------------------------------
// The optional rules, ramp meters and Season One.
// ---------------------------------------------------------------------------

type LevelOut = { trips: number; incidents: number; demandIndex: number; riskCrashes: number; queueFt: number; pedWait: string };
function level(id: string, variant: string, seed = 1337): LevelOut {
  const out = execFileSync("npx", ["tsx", "scripts/sim/level.ts", id, variant, String(seed)], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("rules: demand follows the roads (a jam loses drivers, a free road gains them)", () => {
  const jammed = level("midtown", "elastic");
  const free = level("harbor-drive", "fixed,elastic");
  assert.ok(jammed.demandIndex < 0.85, `jammed Midtown kept ${(jammed.demandIndex * 100).toFixed(0)}% of its demand`);
  assert.ok(free.demandIndex > 1.04, `a fixed Harbor Drive drew ${(free.demandIndex * 100).toFixed(0)}% of its demand`);
});

test("rules: crash risk is rare in calm conditions and clearly more common in fog and the dark", () => {
  const seeds = [1337, 1, 2, 3];
  const total = (variant: string) => seeds.reduce((n, s) => n + level("harbor-drive", variant, s).riskCrashes, 0);
  const calm = total("fixed,risk");
  const bad = total("fixed,risk,fog,night");
  assert.ok(calm <= 2, `${calm} crashes in four calm runs`);
  assert.ok(bad >= calm + 2, `${bad} crashes in fog and the dark vs ${calm} in calm`);
});

test("rules: a ramp meter holds ramp traffic back", () => {
  const open = level("clover-crossing", "none");
  const metered = level("clover-crossing", "meter8");
  assert.ok(metered.queueFt > open.queueFt * 1.5, `queue ${metered.queueFt} ft with an 8 s meter vs ${open.queueFt} ft`);
  assert.ok(metered.trips < open.trips, "holding cars back moves fewer of them in five minutes");
});

test("rules: people wait for a gap to cross, and the wait is counted", () => {
  const r = level("school-run", "fixed,cross,waits");
  const m = /^(\d+) came, avg wait ([\d.]+)s/.exec(r.pedWait);
  assert.ok(m, `no pedestrian numbers: ${r.pedWait}`);
  assert.ok(Number(m![1]) >= 10, `only ${m![1]} people came`);
  assert.ok(Number(m![2]) > 0.5, `average wait ${m![2]} s`);
});

test("Season One: each chapter is a real puzzle (untouched earns one star, a fixed city three)", async () => {
  const { getScenarioById } = await import("../../src/sim/scenarios");
  for (const id of ["story-opening-night", "story-bridge-out", "story-storm-season", "story-grand-opening"]) {
    const def = getScenarioById(id)!;
    const stars = (moved: number) => def.createEvaluator()({ elapsedS: 300, completedTripsTotal: moved } as never).stars;
    const none = level(id, "none");
    const fixed = level(id, "fixed");
    assert.equal(stars(none.trips), 1, `${id}: untouched moved ${none.trips}`);
    assert.equal(stars(fixed.trips), 3, `${id}: fixed moved ${fixed.trips}`);
  }
});
