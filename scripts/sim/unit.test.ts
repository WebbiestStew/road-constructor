// Fast checks of the pure parts (no simulation run): career payouts, service medals, replay files, turn bans, engine pitch.
// Run with `npx tsx --test scripts/sim/unit.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RANKS, payoutFor, rankFor } from "../../src/lib/career";
import { buildServiceReport, MIN_TIMED_TRIPS } from "../../src/lib/serviceReport";
import { engineRevs } from "../../src/lib/sound";
import { applyPatchActions, replayStart, validateReplay, visualPatches } from "../../src/lib/replays";
import { assembleNetwork } from "../../src/sim/network";
import { buildMidtown } from "../../src/sim/cities";
import type { EdgeSpec, LoggedAction, NetworkSnapshot } from "../../src/sim/types";

const noCrashes = { happened: 0, cleared: 0, open: 0, totalClearS: 0, lastClearS: 0 };
const quiet = { services: 0, headwayMeanS: 0, headwayCv: 0, boarded: 0, transfers: 0, heldS: 0 };
const run = (over: Partial<Parameters<typeof buildServiceReport>[0]> = {}) =>
  buildServiceReport({ tripDelayTotalS: 3000, tripFreeFlowTotalS: 6000, tripsTimed: 100, queuePeakFt: 200, pedServedTotal: 0, pedIncidentsTotal: 0, crashes: noCrashes, gridlockPenaltyTotal: 0, combos: 0, transit: quiet, crashRiskOn: false, riskCrashes: 0, pedWaitsOn: false, pedWait: { arrivals: 0, waitTotalS: 0, gaveUp: 0 }, ...over }, { delayShare: 0.6, queueFt: 300 });

test("career: a win pays for new stars and new medals, and a replay pays a trickle", () => {
  const first = payoutFor({ stars: 3, previousStars: 0, earned: ["delay", "gridlock"], previousMedals: [] });
  assert.equal(first.newStars, 3);
  assert.equal(first.newMedals, 2);
  assert.equal(first.funds, 3 * 1000 + 2 * 400 + 100);
  const replay = payoutFor({ stars: 3, previousStars: 3, earned: ["delay", "gridlock"], previousMedals: ["delay", "gridlock"] });
  assert.equal(replay.funds, 100, "nothing new: only the replay trickle");
  const worse = payoutFor({ stars: 1, previousStars: 3, earned: [], previousMedals: [] });
  assert.equal(worse.newStars, 0);
});

test("career: ranks climb with points", () => {
  assert.equal(rankFor(0).rank.name, "Intern");
  assert.equal(rankFor(RANKS[2].points).rank.name, "Engineer");
  assert.equal(rankFor(10_000).next, null);
  assert.equal(rankFor(14).next?.name, "Engineer");
});

test("service report: the delay and queue medals need a clear improvement on the unchanged city", () => {
  const good = run({ tripDelayTotalS: 2400, queuePeakFt: 200 }); // 40% vs 60% baseline; 200 vs 300 ft
  assert.ok(good.medals.find((m) => m.id === "delay")?.earned);
  assert.ok(good.medals.find((m) => m.id === "queue")?.earned);
  const same = run({ tripDelayTotalS: 3600, queuePeakFt: 300 }); // exactly the baseline
  assert.ok(!same.medals.find((m) => m.id === "delay")?.earned);
  assert.ok(!same.medals.find((m) => m.id === "queue")?.earned);
});

test("service report: medals only appear where they apply", () => {
  const ids = (r: ReturnType<typeof run>) => r.medals.map((m) => m.id);
  assert.ok(!ids(run()).includes("peds"), "no pedestrians, no crossing medal");
  assert.ok(ids(run({ pedServedTotal: 10 })).includes("peds"));
  assert.ok(!ids(run({ pedServedTotal: 10, pedIncidentsTotal: 1 })).includes("peds") || !run({ pedServedTotal: 10, pedIncidentsTotal: 1 }).medals.find((m) => m.id === "peds")!.earned);
  assert.ok(ids(run({ crashes: { ...noCrashes, happened: 2, cleared: 2 } })).includes("clear"));
  assert.ok(!ids(run({ tripsTimed: MIN_TIMED_TRIPS - 1 })).includes("delay"), "too few finished trips to judge delay");
  assert.ok(!ids(run({ transit: { ...quiet, services: 3 } })).includes("buses"));
  assert.ok(run({ transit: { ...quiet, services: 20, headwayMeanS: 40, headwayCv: 0.3 } }).medals.find((m) => m.id === "buses")?.earned);
  assert.ok(!run({ transit: { ...quiet, services: 20, headwayMeanS: 40, headwayCv: 0.8 } }).medals.find((m) => m.id === "buses")?.earned);
});

test("engine pitch climbs through a gear and drops at the shift", () => {
  let last = engineRevs(0);
  let shifts = 0;
  for (let mph = 1; mph <= 120; mph += 0.5) {
    const now = engineRevs(mph);
    assert.ok(now.revs >= 0.28 - 1e-9 && now.revs <= 1 + 1e-9, `revs ${now.revs} at ${mph}`);
    if (now.gear === last.gear) assert.ok(now.revs >= last.revs - 1e-9, `revs fell inside gear ${now.gear} at ${mph} mph`);
    else {
      shifts++;
      assert.ok(now.revs < last.revs, `the shift to gear ${now.gear} should drop the revs`);
    }
    last = now;
  }
  assert.ok(shifts >= 4, `only ${shifts} shifts up to 120 mph`);
});

function tinyNetwork(): NetworkSnapshot {
  const edge = (id: string, from: string, to: string): EdgeSpec => ({ id, fromNodeId: from, toNodeId: to, interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 2, laneWidthFt: 12, speedLimitMph: 30 });
  return {
    nodes: [
      { id: "a", position: [0, 0, 0] },
      { id: "b", position: [200, 0, 0] },
    ],
    edges: [edge("ab", "a", "b")],
  };
}

function actions(): LoggedAction[] {
  return [
    { at: 0, msg: { type: "setWeather", weather: "rain" } },
    { at: 0, msg: { type: "setDarkness", level: 1 } },
    { at: 0, msg: { type: "updateNetwork", network: tinyNetwork(), seed: 1337 } },
    { at: 50, msg: { type: "patchEdges", edges: [{ id: "ab", speedLimitMph: 20, laneMoves: null, bannedTurns: ["left"], reservedLane: "hov" }] } },
    { at: 90, msg: { type: "breakdown", durationS: 10 } },
  ];
}

test("replay: the starting state is read from the first actions, and tweaks apply to the roads shown", () => {
  const start = replayStart(actions())!;
  assert.equal(start.weather, "rain");
  assert.equal(start.darkness, 1);
  assert.equal(start.network.edges.length, 1);
  const patches = visualPatches(actions());
  assert.equal(patches.length, 1, "only the road tweak is shown on the map");
  const applied = applyPatchActions(start.network.nodes, start.network.edges, patches);
  assert.equal(applied.edges[0].speedLimitMph, 20);
  assert.deepEqual(applied.edges[0].bannedTurns, ["left"]);
  assert.equal(applied.edges[0].reservedLane, "hov");
  assert.equal(start.network.edges[0].speedLimitMph, 30, "the recording itself is not changed");
});

test("replay files: a damaged or foreign file is refused", () => {
  const ok = { kind: "road-constructor-replay", v: 1, meta: { name: "Test", scenarioId: null, scenarioName: "Test", durationS: 300, stars: 2, score: 100, summary: "x" }, actions: actions() };
  assert.ok(validateReplay(ok), "a good file is accepted");
  assert.equal(validateReplay({ ...ok, kind: "something-else" }), null);
  assert.equal(validateReplay({ ...ok, actions: actions().filter((a) => a.msg.type !== "updateNetwork") }), null, "no roads in it");
  assert.equal(validateReplay({ ...ok, actions: [...actions(), { at: 5, msg: { type: "returnBuffers" } }] }), null, "an action type a replay never holds");
  assert.equal(validateReplay({ ...ok, actions: [{ at: Number.NaN, msg: { type: "crash" } }, ...actions()] }), null);
  const brokenNetwork = actions();
  brokenNetwork[2] = { at: 0, msg: { type: "updateNetwork", network: { nodes: [], edges: [{ nope: true }] } as unknown as NetworkSnapshot, seed: 1 } };
  assert.equal(validateReplay({ ...ok, actions: brokenNetwork }), null, "roads that fail the shared-city check");
});

test("turn bans: a banned turn leaves the graph, the lane arrows and the exits", () => {
  const net = buildMidtown(false);
  const base = assembleNetwork(net);
  const lefts = (n: ReturnType<typeof assembleNetwork>) => n.edges.reduce((sum, e) => sum + [...e.nextMoves.values()].filter((m) => m === "left").length, 0);
  assert.ok(lefts(base) > 0, "the city has left turns to ban");
  const banned = assembleNetwork({ nodes: net.nodes, edges: net.edges.map((e) => ({ ...e, bannedTurns: ["left"] as ("left" | "right")[] })) });
  assert.equal(lefts(banned), 0);
  for (const e of banned.edges) {
    assert.ok(e.nextEdgeIds.length > 0 || base.edgesById.get(e.id)!.nextEdgeIds.length === 0, `${e.id} lost every way out`);
    assert.ok(e.laneMoves.every((moves) => !moves.includes("left")), `${e.id} still shows a left arrow`);
  }
});

test("service report: Vision Zero and Walkable only appear when their rules are on, and need a clean record", () => {
  const ids = (r: ReturnType<typeof run>) => r.medals.map((m) => m.id);
  assert.ok(!ids(run()).includes("safe") && !ids(run()).includes("walkable"));
  assert.ok(run({ crashRiskOn: true }).medals.find((m) => m.id === "safe")?.earned);
  assert.ok(!run({ crashRiskOn: true, riskCrashes: 1, crashes: { ...noCrashes, happened: 1, cleared: 1 } }).medals.find((m) => m.id === "safe")?.earned);
  const waits = (avg: number, gaveUp = 0) => run({ pedWaitsOn: true, pedWait: { arrivals: 20, waitTotalS: avg * 20, gaveUp } }).medals.find((m) => m.id === "walkable");
  assert.ok(waits(5)?.earned);
  assert.ok(!waits(12)?.earned);
  assert.ok(!waits(5, 2)?.earned);
  assert.ok(!ids(run({ pedWaitsOn: true, pedWait: { arrivals: 2, waitTotalS: 4, gaveUp: 0 } })).includes("walkable"), "too few people to judge");
});

test("land use: homes become entries, jobs and shops destinations, and the player's own zones are left alone", async () => {
  const { applyLandUse } = await import("../../src/sim/landUse");
  const edge = (id: string, from: string, to: string, extra: Partial<EdgeSpec> = {}): EdgeSpec => ({ id, fromNodeId: from, toNodeId: to, interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 2, laneWidthFt: 12, speedLimitMph: 30, ...extra });
  const nodes = [
    { id: "a", position: [0, 0, 0] as [number, number, number] },
    { id: "b", position: [600, 0, 0] as [number, number, number] },
    { id: "c", position: [600, 0, 600] as [number, number, number] },
    { id: "d", position: [0, 0, 600] as [number, number, number] },
  ];
  const edges = [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("cd", "c", "d", { zone: { type: "entry", demandVehPerHour: 500 } })];
  const zones = [
    { id: "h1", kind: "home" as const, position: [300, 60] as [number, number], size: 3 as const },
    { id: "h2", kind: "home" as const, position: [320, -40] as [number, number], size: 1 as const },
    { id: "s1", kind: "shop" as const, position: [650, 300] as [number, number], size: 2 as const },
    { id: "far", kind: "work" as const, position: [5000, 5000] as [number, number], size: 2 as const },
  ];
  const out = applyLandUse(nodes, edges, zones);
  const ab = out.find((e) => e.id === "ab")!;
  assert.deepEqual(ab.zone, { type: "entry", demandVehPerHour: 270 + 90 }, "two homes on one road add up");
  assert.equal(out.find((e) => e.id === "bc")!.zone?.type, "destination", "the shop's road is a destination");
  assert.deepEqual(out.find((e) => e.id === "cd")!.zone, { type: "entry", demandVehPerHour: 500 }, "a zone the player placed stays");
  assert.ok(!out.find((e) => e.id === "cd")!.landUseId);
  const cleared = applyLandUse(nodes, out, []);
  assert.equal(cleared.find((e) => e.id === "ab")!.zone, undefined, "removing the zones takes their markers away");
  assert.deepEqual(cleared.find((e) => e.id === "cd")!.zone, { type: "entry", demandVehPerHour: 500 });
});
