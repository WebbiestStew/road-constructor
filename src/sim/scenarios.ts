import { buildCloverleaf, buildHarborDrive, buildInterchangeSite, buildLeftTurnCrossing, buildMidtown } from "./cities";
import { REAL_CITY_DATA } from "./real";
import type { CrashStats, EdgeSpec, EmergencyStats, NetworkSnapshot, NodeSpec, RoadNetwork, ScriptedEvent } from "./types";
import type { EdgeTrafficStats } from "./los";
import { computeRoute } from "./network";
import { computeGradePercent, MAX_GRADE_PERCENT } from "./grade";

/** A generous, JSON-safe stand-in for "infinite" budget in Sandbox Mode — plain `Infinity` doesn't survive JSON persistence. */
export const SANDBOX_BUDGET = 999_999_999;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Tracks how long a boolean condition has held continuously true, resetting to 0 the instant it goes false, capped at `maxS`. Call once per tick with the running sim clock and the latest condition. */
function createSustainTracker(maxS: number): (simTimeS: number, conditionMet: boolean) => number {
  let sustainedS = 0;
  let lastSimTimeS: number | null = null;
  return (simTimeS, conditionMet) => {
    const dt = lastSimTimeS === null ? 0 : Math.max(0, simTimeS - lastSimTimeS);
    lastSimTimeS = simTimeS;
    sustainedS = conditionMet ? Math.min(maxS, sustainedS + dt) : 0;
    return sustainedS;
  };
}

const LOS_C_OR_BETTER = new Set(["A", "B", "C"]);
const LOS_B_OR_BETTER = new Set(["A", "B"]);

/** Everything a scenario's win-condition evaluator needs, refreshed every metrics tick while a run is active. */
export interface ScenarioEvalContext {
  simTimeS: number;
  elapsedS: number;
  avgSpeedMph: number;
  activeCount: number;
  spawnedTotal: number;
  completedTripsTotal: number;
  peopleMovedTotal: number;
  pedServedTotal: number;
  pedIncidentsTotal: number;
  emergency: EmergencyStats;
  crashes: CrashStats;
  gridlockPenaltyTotal: number;
  edgeTrafficStats: EdgeTrafficStats[];
  gridlockMarkers: [number, number, number][];
  budgetRemaining: number;
  network: RoadNetwork;
}

export interface ScenarioProgress {
  won: boolean;
  /** Short live status shown next to the countdown while the scenario runs. */
  label: string;
  /** Multi-line breakdown shown on the results screen once the run ends. */
  detailLines: string[];
  /** The player's number for challenges: vehicles moved (or people moved), where it makes sense to compare runs. */
  score?: number;
  /** Challenge levels set their own star rating (from how many vehicles got through) instead of the speed/budget formula. */
  stars?: 1 | 2 | 3;
}

/** A stateful per-run evaluator closure — each call to `createEvaluator()` gets its own private sustained-timer state, reset on every retry. */
export type ScenarioEvaluator = (ctx: ScenarioEvalContext) => ScenarioProgress;

export interface ScenarioDef {
  id: string;
  name: string;
  tagline: string;
  briefing: string;
  startingNetwork: NetworkSnapshot;
  startingBudget: number;
  durationS: number;
  /** Used only for the post-run star rating, alongside budget remaining. */
  targetAvgSpeedMph: number;
  /**
   * "manage" levels start from a finished city and lock building: the roads are fixed and the player fixes the
   * flow with lane arrows, speed limits and junction control. Undefined = a normal build-and-fix level.
   */
  kind?: "manage";
  /** True for levels built from real OpenStreetMap roads (shown with their own section and credit). */
  real?: boolean;
  /** The real-city data key, for the buildings drawn around its roads. */
  sceneryKey?: string;
  /** Left turns at signals give way to oncoming traffic in this level (otherwise they run unopposed, as in the classic levels). */
  leftTurnsYield?: boolean;
  /** Share of traffic that is buses and bikes in this level. Omitted = cars and trucks only. */
  trafficMix?: { bus: number; bike: number };
  /** Trouble that arrives at fixed moments of the run (a surge, a breakdown), so every attempt faces the same thing. */
  scriptedEvents?: ScriptedEvent[];
  createEvaluator: () => ScenarioEvaluator;
  /** Decorative-only terrain dressing for the scenario's narrative (a river to bridge, a cliff to cut through). */
  terrainFeature?: { kind: "river" | "cliff"; x1: number; z1: number; x2: number; z2: number };
}

export interface ScenarioResult {
  /** The run's comparable score, if its level has one (see ScenarioProgress.score). */
  score: number | null;
  won: boolean;
  stars: 0 | 1 | 2 | 3;
  avgSpeedMph: number;
  budgetSpent: number;
  budgetRemaining: number;
  summaryLines: string[];
}

function node(id: string, x: number, y: number, z: number): NodeSpec {
  return { id, position: [x, y, z] };
}

/** 1-3 stars from how much budget is left and how close average speed came to the scenario's target — only meaningful for a win. */
function computeStars(budgetRemainingFraction: number, avgSpeedMph: number, targetAvgSpeedMph: number): 1 | 2 | 3 {
  const speedFraction = clamp(avgSpeedMph / targetAvgSpeedMph, 0, 1.5);
  const combined = 0.5 * clamp(budgetRemainingFraction, 0, 1) + 0.5 * clamp(speedFraction, 0, 1);
  if (combined >= 0.66) return 3;
  if (combined >= 0.33) return 2;
  return 1;
}

/** Manage levels spend no budget, so their stars come from how freely traffic is flowing at the finish. */
function computeManageStars(avgSpeedMph: number, targetAvgSpeedMph: number): 1 | 2 | 3 {
  const fraction = avgSpeedMph / targetAvgSpeedMph;
  if (fraction >= 0.9) return 3;
  if (fraction >= 0.7) return 2;
  return 1;
}

export function finalizeScenario(
  scenario: ScenarioDef,
  won: boolean,
  ctx: { avgSpeedMph: number; budgetRemaining: number; starsOverride?: 1 | 2 | 3 },
  summaryLines: string[]
): ScenarioResult {
  const budgetRemainingFraction = ctx.budgetRemaining / scenario.startingBudget;
  return {
    score: null,
    won,
    stars: won
      ? ctx.starsOverride !== undefined
        ? ctx.starsOverride
        : scenario.kind === "manage"
        ? computeManageStars(ctx.avgSpeedMph, scenario.targetAvgSpeedMph)
        : computeStars(budgetRemainingFraction, ctx.avgSpeedMph, scenario.targetAvgSpeedMph)
      : 0,
    avgSpeedMph: ctx.avgSpeedMph,
    budgetSpent: scenario.startingBudget - ctx.budgetRemaining,
    budgetRemaining: ctx.budgetRemaining,
    summaryLines,
  };
}

// ---------------------------------------------------------------------------
// 1. The Suburban Choke Point
// ---------------------------------------------------------------------------

const SCP_ENTRY_ROAD = "scpEntryRoad";
const SCP_DEST_ROAD = "scpDestRoad";
// At the scenario's fixed 1000 veh/h entry demand, a 150s run can only ever
// see ~42 vehicles arrive at all (1000/h * 150s/3600s) — 250 was unreachable
// by any build, since demand is locked for campaign scenarios and can't be
// cranked up to compensate. 35 is a real stretch target: hitting it means
// the bridge is flowing with next to no despawns or wasted capacity.
const SCP_TARGET_MOVED = 35;
const SCP_SUSTAIN_S = 60;

const suburbanChokePointNetwork: NetworkSnapshot = {
  nodes: [node("scpN1", -500, 0, 0), node("scpN2", -150, 0, 0), node("scpN3", 150, 0, 0), node("scpN4", 500, 0, 0)],
  edges: [
    {
      id: SCP_ENTRY_ROAD,
      fromNodeId: "scpN1",
      toNodeId: "scpN2",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 1000 },
    },
    {
      id: SCP_DEST_ROAD,
      fromNodeId: "scpN3",
      toNodeId: "scpN4",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "destination", targetSpeedMph: 25 },
    },
  ] satisfies EdgeSpec[],
};

function createSuburbanChokePointEvaluator(): ScenarioEvaluator {
  let sustainedS = 0;
  let lastSimTimeS: number | null = null;

  return (ctx) => {
    const dt = lastSimTimeS === null ? 0 : Math.max(0, ctx.simTimeS - lastSimTimeS);
    lastSimTimeS = ctx.simTimeS;

    const entryStats = ctx.edgeTrafficStats.find((s) => s.edgeId === SCP_ENTRY_ROAD);
    const hasTraffic = (entryStats?.vehicleCount ?? 0) > 0;
    const losOk = !!entryStats && (entryStats.los === "A" || entryStats.los === "B" || entryStats.los === "C");

    if (hasTraffic && losOk) sustainedS = Math.min(SCP_SUSTAIN_S, sustainedS + dt);
    else sustainedS = 0;

    const moved = Math.min(ctx.completedTripsTotal, SCP_TARGET_MOVED);
    const won = ctx.completedTripsTotal >= SCP_TARGET_MOVED && sustainedS >= SCP_SUSTAIN_S;

    return {
      won,
      label: `${moved} / ${SCP_TARGET_MOVED} moved · LOS C+ held ${Math.round(sustainedS)}s / ${SCP_SUSTAIN_S}s`,
      detailLines: [
        `Vehicles moved: ${ctx.completedTripsTotal} / ${SCP_TARGET_MOVED}`,
        `Entry corridor LOS: ${entryStats?.los ?? "—"} (need C or better, held ${SCP_SUSTAIN_S}s straight)`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 2. The Bypassed Town (Texas Turnaround)
// ---------------------------------------------------------------------------

const BT_MAINLINE_WEST = "btMainlineWest";
const BT_MAINLINE_EAST = "btMainlineEast";
const BT_CROSS_SOUTH = "btCrossSouth";
const BT_CROSS_NORTH = "btCrossNorth";
const BT_DURATION_S = 150;
const BT_PEAK_WINDOW_S = 60;

const bypassedTownNetwork: NetworkSnapshot = {
  nodes: [
    node("btN1", -400, 0, 0),
    node("btN0", 0, 0, 0),
    node("btN2", 400, 0, 0),
    node("btN3", 0, 0, -300),
    node("btN4", 0, 0, 300),
  ].map((n, i) => (i === 1 ? { ...n, control: { type: "signal" as const, groupA: [BT_MAINLINE_WEST], groupB: [BT_CROSS_SOUTH, BT_CROSS_NORTH], greenDurationS: 20, allRedDurationS: 2 } } : n)),
  edges: [
    {
      id: BT_MAINLINE_WEST,
      fromNodeId: "btN1",
      toNodeId: "btN0",
      interiorPoints: [],
      roadClassId: "avenue",
      elevationLevelId: "ground",
      lanes: 2,
      laneWidthFt: 11,
      speedLimitMph: 40,
      zone: { type: "entry", demandVehPerHour: 1400 },
    },
    {
      id: BT_MAINLINE_EAST,
      fromNodeId: "btN0",
      toNodeId: "btN2",
      interiorPoints: [],
      roadClassId: "avenue",
      elevationLevelId: "ground",
      lanes: 2,
      laneWidthFt: 11,
      speedLimitMph: 40,
      zone: { type: "destination", targetSpeedMph: 30 },
    },
    {
      id: BT_CROSS_SOUTH,
      fromNodeId: "btN3",
      toNodeId: "btN0",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 900 },
    },
    {
      id: BT_CROSS_NORTH,
      fromNodeId: "btN4",
      toNodeId: "btN0",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 700 },
    },
  ] satisfies EdgeSpec[],
};

function createBypassedTownEvaluator(): ScenarioEvaluator {
  let violated = false;
  let penaltyAtWindowStart: number | null = null;

  return (ctx) => {
    const windowStartS = Math.max(0, BT_DURATION_S - BT_PEAK_WINDOW_S);
    const inPeakWindow = ctx.elapsedS >= windowStartS;

    if (inPeakWindow) {
      if (penaltyAtWindowStart === null) penaltyAtWindowStart = ctx.gridlockPenaltyTotal;
      if (ctx.gridlockMarkers.length > 0 || ctx.gridlockPenaltyTotal > penaltyAtWindowStart) violated = true;
    }

    const runComplete = ctx.elapsedS >= BT_DURATION_S;
    const won = runComplete && inPeakWindow && !violated;

    return {
      won,
      label: !inPeakWindow
        ? `Peak minute begins at ${Math.round(windowStartS)}s`
        : violated
          ? "Standstill detected during the peak minute ❌"
          : "Holding steady through the peak minute ✅",
      detailLines: [
        violated
          ? "A vehicle came to a complete standstill during the peak rush minute."
          : "No vehicle came to a complete standstill during the peak rush minute.",
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 3. The Mountain Cut
// ---------------------------------------------------------------------------

const MC_ENTRY_ROAD = "mcEntryRoad";
const MC_DEST_ROAD = "mcDestRoad";
const MC_TARGET_FLOW_VEH_PER_HOUR = 400;
const MC_SUSTAIN_S = 20;

const mountainCutNetwork: NetworkSnapshot = {
  nodes: [
    node("mcN1", -450, -35, 0),
    node("mcN1b", -350, -35, 0),
    node("mcN2b", 350, 42, 0),
    node("mcN2", 450, 42, 0),
  ],
  edges: [
    {
      id: MC_ENTRY_ROAD,
      fromNodeId: "mcN1",
      toNodeId: "mcN1b",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 550 },
    },
    {
      id: MC_DEST_ROAD,
      fromNodeId: "mcN2b",
      toNodeId: "mcN2",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "destination", targetSpeedMph: 25 },
    },
  ] satisfies EdgeSpec[],
};

function createMountainCutEvaluator(): ScenarioEvaluator {
  let sustainedS = 0;
  let lastSimTimeS: number | null = null;

  return (ctx) => {
    const dt = lastSimTimeS === null ? 0 : Math.max(0, ctx.simTimeS - lastSimTimeS);
    lastSimTimeS = ctx.simTimeS;

    const overGradeCount = ctx.network.edges.filter((e) => {
      const from = ctx.network.nodesById.get(e.fromNodeId);
      const to = ctx.network.nodesById.get(e.toNodeId);
      return !!from && !!to && Math.abs(computeGradePercent(from.position, to.position)) > MAX_GRADE_PERCENT;
    }).length;

    const connected = computeRoute(ctx.network, MC_ENTRY_ROAD, MC_DEST_ROAD) !== null;

    const destEdge = ctx.network.edgesById.get(MC_DEST_ROAD);
    const destStats = ctx.edgeTrafficStats.find((s) => s.edgeId === MC_DEST_ROAD);
    const flowVehPerHour = destStats && destEdge ? destStats.flowPerLaneVehPerHour * destEdge.lanes : 0;
    const flowOk = flowVehPerHour >= MC_TARGET_FLOW_VEH_PER_HOUR;

    if (connected && flowOk && overGradeCount === 0) sustainedS = Math.min(MC_SUSTAIN_S, sustainedS + dt);
    else sustainedS = 0;

    const won = sustainedS >= MC_SUSTAIN_S;

    return {
      won,
      label: !connected
        ? "Not connected yet"
        : overGradeCount > 0
          ? `⚠ ${overGradeCount} segment${overGradeCount === 1 ? "" : "s"} over ${MAX_GRADE_PERCENT}% grade`
          : `${Math.round(flowVehPerHour)} veh/h · held ${Math.round(sustainedS)}s / ${MC_SUSTAIN_S}s`,
      detailLines: [
        connected ? "Route connects both endpoints." : "Route does not yet connect both endpoints.",
        `Grade limit: ${overGradeCount === 0 ? "all segments within " + MAX_GRADE_PERCENT + "%" : overGradeCount + " segment(s) exceed " + MAX_GRADE_PERCENT + "%"}`,
        `Sustained flow: ${Math.round(flowVehPerHour)} / ${MC_TARGET_FLOW_VEH_PER_HOUR} veh/h`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 4. Five-Points Free-for-All
// ---------------------------------------------------------------------------

const FP_ENTRY_N = "fpEntryN";
const FP_DEST_S = "fpDestS";
const FP_ENTRY_E = "fpEntryE";
const FP_DEST_W = "fpDestW";
const FP_ENTRY_NE = "fpEntryNE";
const FP_SUSTAIN_S = 45;

const fivePointsNetwork: NetworkSnapshot = {
  nodes: [
    node("fpC", 0, 0, 0),
    node("fpN", 0, 0, -380),
    node("fpS", 0, 0, 380),
    node("fpE", 380, 0, 0),
    node("fpW", -380, 0, 0),
    node("fpNE", 270, 0, -270),
  ],
  edges: [
    { id: FP_ENTRY_N, fromNodeId: "fpN", toNodeId: "fpC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 500 } },
    { id: FP_DEST_S, fromNodeId: "fpC", toNodeId: "fpS", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: 22 } },
    { id: FP_ENTRY_E, fromNodeId: "fpE", toNodeId: "fpC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 450 } },
    { id: FP_DEST_W, fromNodeId: "fpC", toNodeId: "fpW", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: 22 } },
    { id: FP_ENTRY_NE, fromNodeId: "fpNE", toNodeId: "fpC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 380 } },
  ] satisfies EdgeSpec[],
};

/**
 * Win condition for the Traffic Manager levels and the interchange: get `target` vehicles all the way to their
 * destinations before the clock runs out. Cumulative trips are smooth and deterministic (the sim is seeded), unlike
 * an instantaneous average speed, and the targets sit between the broken city and the fixed one, found by running
 * both in the headless sim.
 */
function createTripsEvaluator(target: number): () => ScenarioEvaluator {
  return () => (ctx) => {
    const moved = Math.min(ctx.completedTripsTotal, target);
    return {
      won: ctx.completedTripsTotal >= target,
      label: `${moved} / ${target} moved · ${Math.round(ctx.avgSpeedMph)} mph now`,
      detailLines: [
        `Vehicles moved: ${ctx.completedTripsTotal} / ${target}`,
        `Gridlock penalties: ${ctx.gridlockPenaltyTotal} stuck vehicles removed`,
      ],
    };
  };
}

/**
 * Win condition for levels where the fault is a speed collapse: after a warm-up (traffic takes a couple of
 * minutes to back up), average speed must hold above a line for a stretch. The line sits between the broken
 * city (low teens) and the fixed one (about 20 mph), found by running both in the headless sim.
 */
function createSpeedHoldEvaluator(opts: { warmupS: number; minMph: number; holdS: number }): () => ScenarioEvaluator {
  return () => {
    const sustain = createSustainTracker(opts.holdS);
    return (ctx) => {
      const flowing = ctx.elapsedS >= opts.warmupS && ctx.activeCount > 20 && ctx.avgSpeedMph >= opts.minMph;
      const heldS = sustain(ctx.simTimeS, flowing);
      const warm = ctx.elapsedS < opts.warmupS;
      return {
        won: heldS >= opts.holdS,
        label: warm
          ? `Traffic building up… ${Math.round(ctx.avgSpeedMph)} mph`
          : `${Math.round(ctx.avgSpeedMph)} mph · hold ${opts.minMph}+ for ${opts.holdS}s (${Math.round(heldS)}s)`,
        detailLines: [
          `Average speed: ${Math.round(ctx.avgSpeedMph)} mph (need ${opts.minMph}+ held ${opts.holdS}s straight, after the first ${opts.warmupS}s)`,
          `Vehicles moved: ${ctx.completedTripsTotal}`,
        ],
      };
    };
  };
}

/**
 * A score challenge: nothing to pass or fail, you play the whole run and your vehicles-moved total is the score.
 * Stars compare it to `par`, the total a fully fixed city reaches in the headless sim (so 3 stars means you
 * found essentially everything). Used for the scripted-trouble levels and the daily challenge, where the sim's
 * run-to-run variation makes a hard pass line unfair.
 */
export function createChallengeEvaluator(par: number, durationS: number): () => ScenarioEvaluator {
  return () => (ctx) => {
    const done = ctx.elapsedS >= durationS - 0.5;
    const stars: 1 | 2 | 3 = ctx.completedTripsTotal >= par * 0.97 ? 3 : ctx.completedTripsTotal >= par * 0.9 ? 2 : 1;
    return {
      won: done,
      stars,
      score: ctx.completedTripsTotal,
      label: `${ctx.completedTripsTotal} moved · par ${par}`,
      detailLines: [
        `Vehicles moved: ${ctx.completedTripsTotal} (par ${par}, a fully fixed city)`,
        `3 stars at ${Math.ceil(par * 0.97)}, 2 stars at ${Math.ceil(par * 0.9)}`,
        `Gridlock penalties: ${ctx.gridlockPenaltyTotal}`,
      ],
    };
  };
}

const SURGE_NIGHT: ScriptedEvent[] = [{ atS: 90, kind: "surge", multiplier: 1.8, durationS: 70 }];
const ROUGH_MORNING: ScriptedEvent[] = [
  { atS: 60, kind: "breakdown", durationS: 18 },
  { atS: 130, kind: "breakdown", durationS: 18 },
  { atS: 200, kind: "breakdown", durationS: 18 },
];

/**
 * Star rating for the real-city levels, measured against what the unmodified city does: nobody knows what a "good"
 * score is on a real road network, so the yardstick is the player's own improvement. Beat the baseline by 4% for two
 * stars and 10% for three. The baselines are vehicles moved in the 300 s run, measured in the headless sim.
 */
function createRealCityEvaluator(baseline: number, durationS: number, threeStarRatio = 1.12, twoStarRatio = 1.07): () => ScenarioEvaluator {
  // Baselines are the mean of eight seeds (seed-to-seed spread is 2-5%), so an untouched city only reaches two stars
  // by luck, while a real fix still clears three.
  const two = Math.ceil(baseline * twoStarRatio);
  const three = Math.ceil(baseline * threeStarRatio);
  return () => (ctx) => {
    const stars: 1 | 2 | 3 = ctx.completedTripsTotal >= three ? 3 : ctx.completedTripsTotal >= two ? 2 : 1;
    return {
      won: ctx.elapsedS >= durationS - 0.5,
      stars,
      score: ctx.completedTripsTotal,
      label: `${ctx.completedTripsTotal} moved · city baseline ${baseline}`,
      detailLines: [
        `Vehicles moved: ${ctx.completedTripsTotal} (the unchanged city moves ${baseline})`,
        `2 stars at ${two}, 3 stars at ${three}`,
        `Budget left: $${Math.max(0, Math.round(ctx.budgetRemaining)).toLocaleString()}`,
      ],
    };
  };
}

/** Targets for the levels that score something other than vehicles moved, measured in the headless sim (see scripts/sim/level.ts). */
/** People the unchanged street moves in 300 s with 16% buses. Reserving bus lanes on every avenue moves about 18% more. */
const TRANSIT_BASELINE_PEOPLE = 2625;
/** Unchanged, ambulances take about 2x an empty road; a reserved bus lane as a fast lane gets them to about 1.4x. */
const CODE_THREE_RATIO = { three: 1.6, two: 1.85 };
/** Vehicles moved by a fully fixed Harbor Drive in the rain. The unchanged street moves about 85% of this. */
const RAINY_PAR = 239;
/** Vehicles moved by a fully fixed street with crossings on both school blocks. */
const SCHOOL_PAR = 226;

/**
 * Transit Street: the score is people moved, not vehicles, so a lane for buses (which carry a couple of dozen riders
 * each) can win even while it costs cars some road. Stars are relative to what the unchanged street carries.
 */
function createPeopleEvaluator(baseline: number, durationS: number): () => ScenarioEvaluator {
  const two = Math.ceil(baseline * 1.05);
  const three = Math.ceil(baseline * 1.14);
  return () => (ctx) => {
    const people = Math.round(ctx.peopleMovedTotal);
    const stars: 1 | 2 | 3 = people >= three ? 3 : people >= two ? 2 : 1;
    return {
      won: ctx.elapsedS >= durationS - 0.5,
      stars,
      score: people,
      label: `${people} people moved · street baseline ${baseline}`,
      detailLines: [
        `People moved: ${people} (the unchanged street carries ${baseline})`,
        `2 stars at ${two}, 3 stars at ${three}`,
        `Vehicles moved: ${ctx.completedTripsTotal}`,
      ],
    };
  };
}

/** Code Three: how fast ambulances get through, as a multiple of what an empty road would take. */
function createEmergencyEvaluator(calls: number, ratios: { three: number; two: number }, durationS: number): () => ScenarioEvaluator {
  return () => (ctx) => {
    const e = ctx.emergency;
    const ratio = e.totalIdealS > 0 ? e.totalResponseS / e.totalIdealS : 0;
    const allIn = e.completed >= calls;
    const stars: 1 | 2 | 3 = allIn && ratio <= ratios.three ? 3 : e.completed >= calls - 1 && ratio <= ratios.two ? 2 : 1;
    return {
      won: ctx.elapsedS >= durationS - 0.5,
      stars,
      label: `🚑 ${e.completed}/${calls} arrived${e.completed > 0 ? ` · ×${ratio.toFixed(1)}` : ""}`,
      detailLines: [
        `Ambulances arrived: ${e.completed} of ${calls}`,
        e.completed > 0 ? `Average time: ${ratio.toFixed(2)}× an empty road` : "None arrived yet",
        `3 stars: all arrive within ×${ratios.three.toFixed(1)}. 2 stars: ×${ratios.two.toFixed(1)}`,
      ],
    };
  };
}

/** School Run: nobody steps into traffic, and the city still moves. */
function createSafeStreetsEvaluator(par: number, durationS: number): () => ScenarioEvaluator {
  return () => (ctx) => {
    const moved = ctx.completedTripsTotal;
    const incidents = ctx.pedIncidentsTotal;
    const stars: 1 | 2 | 3 = incidents === 0 && moved >= par * 0.92 ? 3 : incidents <= 2 && moved >= par * 0.8 ? 2 : 1;
    return {
      won: ctx.elapsedS >= durationS - 0.5,
      stars,
      label: `${incidents} stepped into traffic · ${moved} moved`,
      detailLines: [
        `Stepped into traffic: ${incidents}`,
        `Vehicles moved: ${moved} (par ${par})`,
        "3 stars: nobody steps into traffic and traffic keeps up. 2 stars: two or fewer incidents",
      ],
    };
  };
}

/** Pile-Up: how fast crashes are cleared. Police have to drive to the wreck, so a jammed road makes a crash last longer. */
function createCrashEvaluator(calls: number, durationS: number): () => ScenarioEvaluator {
  return () => (ctx) => {
    const c = ctx.crashes;
    const avg = c.cleared > 0 ? c.totalClearS / c.cleared : 0;
    const allDone = c.cleared >= calls;
    const stars: 1 | 2 | 3 = allDone && avg <= 75 ? 3 : c.cleared >= calls - 1 && avg <= 100 ? 2 : 1;
    return {
      won: ctx.elapsedS >= durationS - 0.5,
      stars,
      label: `💥 ${c.cleared}/${calls} cleared${c.cleared > 0 ? ` · avg ${Math.round(avg)}s` : ""}`,
      detailLines: [
        `Crashes cleared: ${c.cleared} of ${calls}`,
        c.cleared > 0 ? `Average time to clear: ${Math.round(avg)}s` : "None cleared yet",
        "3 stars: all cleared, averaging 75 s or less. 2 stars: all but one, 100 s or less",
      ],
    };
  };
}

/** A copy of a network with people wanting to cross the named roads (both directions of each). */
function withJaywalkers(net: NetworkSnapshot, roadIds: string[]): NetworkSnapshot {
  const ids = new Set(roadIds.flatMap((id) => [`${id}f`, `${id}b`]));
  return { nodes: net.nodes, edges: net.edges.map((e) => (ids.has(e.id) ? { ...e, jaywalkers: true } : e)) };
}

const PILE_UP_EVENTS: ScriptedEvent[] = [40, 100, 160, 220].map((atS) => ({ atS, kind: "crash" as const }));
const CODE_THREE_EVENTS: ScriptedEvent[] = [30, 85, 140, 195].map((atS) => ({ atS, kind: "ambulance" as const }));
const RAINY_EVENTS: ScriptedEvent[] = [
  { atS: 30, kind: "weather", weather: "rain", durationS: 220 },
  { atS: 100, kind: "surge", multiplier: 1.5, durationS: 70 },
];

export interface RealCityPlan {
  key: string;
  name: string;
  tagline: string;
  briefing: string;
  budget: number;
  /** Mean vehicles moved in 300 s by the unmodified network over eight seeds in the headless sim. */
  baseline: number;
  /** Three stars at this multiple of the baseline when the default (1.12) is out of reach. */
  threeStarRatio?: number;
  /** Two stars at this multiple of the baseline (default 1.07); raised where the untouched run varies a lot from seed to seed. */
  twoStarRatio?: number;
  /** Length of the run in seconds (300 unless the trips are long enough that five minutes would measure nothing). */
  durationS?: number;
}

export const REAL_PLANS: RealCityPlan[] = [
  {
    key: "los-angeles",
    name: "Los Angeles: Four Level",
    tagline: "The most famous stack of ramps in America.",
    briefing:
      "Downtown LA, where US-101 meets the Harbor Freeway on four stacked levels. These are the real roads, ramps and lane counts. Rush hour is jamming it. Widen the right lanes, retime the lights and tune the limits, but you can't afford to fix everything.",
    budget: 9_000_000,
    baseline: 787,
  },
  {
    key: "new-york",
    name: "New York: Midtown",
    tagline: "Times Square at rush hour. One-way streets and a light on every corner.",
    briefing:
      "Midtown Manhattan around Times Square: real one-way avenues and streets with a traffic light at nearly every block. There's no room to widen, so it's all about timing: green lengths, offsets for a green wave, and which corners need a light at all.",
    budget: 4_000_000,
    baseline: 555,
  },
  {
    key: "toronto",
    name: "Toronto: Gardiner",
    tagline: "An elevated expressway looming over the waterfront.",
    briefing:
      "Toronto's waterfront, where the elevated Gardiner Expressway runs over Lake Shore Boulevard and the downtown ramps. Real elevations, real ramps. Find the bottleneck where the ramps meet the street grid.",
    budget: 7_000_000,
    baseline: 545,
  },
  {
    key: "houston",
    name: "Houston: I-45 & I-10",
    tagline: "A knot of freeway ramps north of downtown.",
    briefing:
      "Where I-45 meets I-10 just north of downtown Houston, a dense tangle of real ramps and flyovers. There are no lights to retime, so widen the ramps and lanes that choke, and spend the budget where it counts.",
    budget: 8_000_000,
    baseline: 910,
  },
  {
    key: "san-antonio",
    name: "San Antonio: The Y",
    tagline: "I-35, I-10 and US-281 collide just north of downtown.",
    briefing:
      "The freeway knot just north of downtown San Antonio, where I-35, I-10 and US-281 all meet. Real geometry, real flyovers. It's slow because a few ramps carry far more than they were built for. Find them and add capacity.",
    budget: 8_000_000,
    baseline: 324,
  },
  {
    key: "monterrey",
    name: "Monterrey: Downtown",
    tagline: "The Macroplaza grid, crowded in every direction.",
    briefing:
      "Downtown Monterrey around the Macroplaza: a big grid of real streets, avenues and signals, with far more cars than the grid wants. Retime the lights, fix the limits and widen the worst streets to keep the center moving.",
    budget: 7_000_000,
    baseline: 495,
  },
  {
    key: "dallas",
    name: "Dallas: High Five",
    tagline: "Five levels of ramps, and Texas traffic on all of them.",
    briefing:
      "Where I-635 meets US-75 north of Dallas, on the real stack of flyovers. The ramps and lane counts are the real ones, and the afternoon crowd is on its way home. Add lanes where the weaves choke, retime the limits, and spend the budget where it matters most.",
    budget: 9_000_000,
    baseline: 736,
  },
  {
    key: "chicago",
    name: "Chicago: Jane Byrne",
    tagline: "The Circle Interchange, where three expressways collide.",
    briefing:
      "The Jane Byrne Interchange west of the Loop, where the Kennedy, the Dan Ryan and the Eisenhower meet. Notoriously jammed, and the ramps are tight. Find the lane that's starving the rest and fix it with the money you have.",
    budget: 8_000_000,
    baseline: 482,
  },
  {
    key: "atlanta",
    name: "Atlanta: Spaghetti Junction",
    tagline: "I-85 and I-285 tangled into one big knot.",
    briefing:
      "The Tom Moreland Interchange, better known as Spaghetti Junction, rebuilt from the real roads. Dozens of ramps, with the whole metro trying to get through. Widen, retime and re-limit until the knot loosens.",
    budget: 8_000_000,
    baseline: 994,
    // Trips here are long (a three-mile map), so the 5-minute count is mostly travel time: the best realistic play reaches about +10%.
    threeStarRatio: 1.09,
  },
  {
    key: "lincoln-tunnel",
    name: "Lincoln Tunnel: Jersey to the Boroughs",
    tagline: "Out of the helix, under the Hudson, across Midtown, and on to Queens and Brooklyn.",
    briefing:
      "Everything here comes in from New Jersey: the Route 495 helix, the Lincoln Tunnel under the Hudson, and the Weehawken streets beside it. It comes out at 39th Street in Midtown, crosses Manhattan on the real avenues, and leaves by the Queens-Midtown Tunnel and the Queensboro Bridge for Queens, or down the east side for Brooklyn. It is a long haul, so the clock runs fifteen minutes. Find the avenue that chokes the tunnel mouth and fix it.",
    budget: 14_000_000,
    baseline: 224,
    durationS: 1800,
  },
  {
    key: "monterrey-tec",
    name: "Monterrey: Tec de Monterrey",
    tagline: "Garza Sada along the Tec.",
    briefing:
      "Avenida Eugenio Garza Sada runs along the Tecnológico de Monterrey campus. The roads, lanes, speed limits and signals here are the real ones from OpenStreetMap, with everyone from the neighbourhood and the campus loaded onto them. Find what holds the avenue up and fix it.",
    budget: 7_000_000,
    baseline: 242,
    twoStarRatio: 1.1,
    threeStarRatio: 1.18,
  },
  {
    key: "monterrey-valle-oriente",
    name: "Monterrey: Valle Oriente",
    tagline: "Lázaro Cárdenas through Valle Oriente.",
    briefing:
      "Valle Oriente, in San Pedro Garza García: Lázaro Cárdenas, Fundadores and the ramps between them, drawn from the real roads. Wide roads, long blocks and few places to turn. Open the bottlenecks without spending the budget on roads that don't need it.",
    budget: 7_000_000,
    baseline: 175,
    twoStarRatio: 1.1,
    threeStarRatio: 1.18,
  },
  {
    key: "monterrey-uanl",
    name: "Monterrey: Ciudad Universitaria",
    tagline: "Avenida Universidad at Ciudad Universitaria.",
    briefing:
      "Ciudad Universitaria of the UANL, where Avenida Universidad, Fidel Velázquez and Nogalar meet around a set of ramps, all taken from the real map. Several flows want the same few intersections. Retime, re-limit and widen until it moves.",
    budget: 7_000_000,
    baseline: 349,
    twoStarRatio: 1.1,
    threeStarRatio: 1.18,
  },
  {
    key: "monterrey-hospital-universitario",
    name: "Monterrey: Gonzalitos",
    tagline: "Gonzalitos by the Hospital Universitario.",
    briefing:
      "Avenida Gonzalitos by the Hospital Universitario, crossed by Madero and Paseo de los Leones, taken from the real map. A long avenue that meets every cross street. Find where it backs up and fix it.",
    budget: 7_000_000,
    baseline: 202,
    twoStarRatio: 1.1,
    threeStarRatio: 1.18,
  },
  {
    key: "monterrey-fundidora",
    name: "Monterrey: Fundidora",
    tagline: "The ramps around Parque Fundidora.",
    briefing:
      "The roads around Parque Fundidora: Avenida Fundidora, Cristóbal Colón and the Madero ramps, taken from the real map. A small, tightly wound area where every lane counts. Untangle the ramps and keep traffic moving past the park.",
    budget: 7_000_000,
    baseline: 270,
  },
  {
    key: "monterrey-estadio",
    name: "Monterrey: Estadio BBVA",
    tagline: "Pablo Livas around the Estadio BBVA.",
    briefing:
      "The roads around the Estadio BBVA in Guadalupe: Pablo Livas, Las Torres and Exposición, taken from the real map. Wide avenues, long gaps between signals and only a few ways in. Keep them flowing.",
    budget: 7_000_000,
    baseline: 148,
    twoStarRatio: 1.16,
    threeStarRatio: 1.26,
  },
  {
    key: "monterrey-juan-pablo-ii",
    name: "Monterrey: Juan Pablo II",
    tagline: "Universidad at Juan Pablo II.",
    briefing:
      "Avenida Universidad at Juan Pablo II and Jorge A. Treviño in the north of the city, taken from the real map: fast avenues and tight ramps. A good place to try a different signal plan and see what the real roads can carry.",
    budget: 7_000_000,
    baseline: 295,
    twoStarRatio: 1.1,
    threeStarRatio: 1.18,
  },
];

function realScenario(plan: RealCityPlan): ScenarioDef {
  return {
    id: `real-${plan.key}`,
    real: true,
    sceneryKey: plan.key,
    name: plan.name,
    tagline: plan.tagline,
    briefing: plan.briefing,
    startingNetwork: REAL_CITY_DATA[plan.key].network,
    startingBudget: plan.budget,
    durationS: plan.durationS ?? 300,
    targetAvgSpeedMph: 25,
    createEvaluator: createRealCityEvaluator(plan.baseline, plan.durationS ?? 300, plan.threeStarRatio, plan.twoStarRatio),
  };
}

const REAL_SCENARIOS: ScenarioDef[] = REAL_PLANS.map(realScenario);

const MIDTOWN_NETWORK = buildMidtown(true);
const HARBOR_NETWORK = buildHarborDrive(true);
const TRANSIT_NETWORK = buildMidtown(false);
const SCHOOL_NETWORK = withJaywalkers(buildHarborDrive(true), ["m2", "m3"]);
/** First Shift: Harbor Drive with a slow block and an angry light, plus one block where kids cross. No lane-arrow trouble, so every fault has an obvious fix. */
const FIRST_SHIFT_NETWORK = withJaywalkers(buildHarborDrive({ speed: true, signal: true }), ["m1"]);
/** Vehicles moved by a fully fixed First Shift (limits and lights repaired, crossing added). */
const FIRST_SHIFT_PAR = 236;
const INTERCHANGE_NETWORK = buildInterchangeSite();
const CLOVERLEAF_NETWORK = buildCloverleaf();
const LEFT_TURN_NETWORK = buildLeftTurnCrossing();
/** Vehicles moved in 300 s by the untouched Continuous Flow crossing, the mean of eight seeds in the headless sim. */
const CONTINUOUS_FLOW_BASELINE = 89;
/** Vehicles moved in 300 s by the untouched Clover Crossing, the mean of eight seeds in the headless sim. */
const CLOVER_BASELINE = 258;
function createFivePointsEvaluator(): ScenarioEvaluator {
  const sustain = createSustainTracker(FP_SUSTAIN_S);
  return (ctx) => {
    const n = ctx.edgeTrafficStats.find((s) => s.edgeId === FP_ENTRY_N);
    const e = ctx.edgeTrafficStats.find((s) => s.edgeId === FP_ENTRY_E);
    const ne = ctx.edgeTrafficStats.find((s) => s.edgeId === FP_ENTRY_NE);
    const allOk = [n, e, ne].every((s) => !!s && LOS_C_OR_BETTER.has(s.los));
    const sustainedS = sustain(ctx.simTimeS, allOk);
    const won = sustainedS >= FP_SUSTAIN_S;

    return {
      won,
      label: `All 3 approaches LOS C+ held ${Math.round(sustainedS)}s / ${FP_SUSTAIN_S}s`,
      detailLines: [
        `North approach LOS: ${n?.los ?? "—"}`,
        `East approach LOS: ${e?.los ?? "—"}`,
        `Northeast approach LOS: ${ne?.los ?? "—"}`,
        `All three held C or better for: ${Math.round(sustainedS)}s / ${FP_SUSTAIN_S}s`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 5. The Diverging Destinations
// ---------------------------------------------------------------------------

const DD_ENTRY = "ddEntry";
const DD_DEST_A = "ddDestA";
const DD_DEST_B = "ddDestB";
const DD_TARGET_A_MPH = 28;
const DD_TARGET_B_MPH = 20;
const DD_SUSTAIN_S = 30;

const divergingDestinationsNetwork: NetworkSnapshot = {
  nodes: [
    node("ddN1", -500, 0, 0),
    node("ddN1b", -350, 0, 0),
    node("ddFork", 0, 0, 0),
    node("ddA", 300, 0, -230),
    node("ddB", 300, 0, 230),
  ],
  edges: [
    { id: DD_ENTRY, fromNodeId: "ddN1", toNodeId: "ddN1b", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 900 } },
    { id: DD_DEST_A, fromNodeId: "ddFork", toNodeId: "ddA", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 35, zone: { type: "destination", targetSpeedMph: DD_TARGET_A_MPH } },
    { id: DD_DEST_B, fromNodeId: "ddFork", toNodeId: "ddB", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 25, zone: { type: "destination", targetSpeedMph: DD_TARGET_B_MPH } },
  ] satisfies EdgeSpec[],
};

function createDivergingDestinationsEvaluator(): ScenarioEvaluator {
  const sustain = createSustainTracker(DD_SUSTAIN_S);
  return (ctx) => {
    const a = ctx.edgeTrafficStats.find((s) => s.edgeId === DD_DEST_A);
    const b = ctx.edgeTrafficStats.find((s) => s.edgeId === DD_DEST_B);
    const aOk = !!a && a.vehicleCount > 0 && a.avgSpeedMph >= DD_TARGET_A_MPH;
    const bOk = !!b && b.vehicleCount > 0 && b.avgSpeedMph >= DD_TARGET_B_MPH;
    const sustainedS = sustain(ctx.simTimeS, aOk && bOk);
    const won = sustainedS >= DD_SUSTAIN_S;

    return {
      won,
      label: `Both branches at target speed: ${Math.round(sustainedS)}s / ${DD_SUSTAIN_S}s`,
      detailLines: [
        `Branch A speed: ${a ? Math.round(a.avgSpeedMph) : "—"} mph (target ${DD_TARGET_A_MPH})`,
        `Branch B speed: ${b ? Math.round(b.avgSpeedMph) : "—"} mph (target ${DD_TARGET_B_MPH})`,
        `Held both simultaneously for: ${Math.round(sustainedS)}s / ${DD_SUSTAIN_S}s`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 6. Budget Lockdown
// ---------------------------------------------------------------------------

const BL_ENTRY = "blEntry";
const BL_DEST = "blDest";
const BL_SUSTAIN_S = 90;

const budgetLockdownNetwork: NetworkSnapshot = {
  nodes: [node("blN1", -500, 0, 0), node("blN2", -150, 0, 0), node("blN3", 150, 0, 0), node("blN4", 500, 0, 0)],
  edges: [
    { id: BL_ENTRY, fromNodeId: "blN1", toNodeId: "blN2", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 1600 } },
    { id: BL_DEST, fromNodeId: "blN3", toNodeId: "blN4", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: 24 } },
  ] satisfies EdgeSpec[],
};

function createBudgetLockdownEvaluator(): ScenarioEvaluator {
  const sustain = createSustainTracker(BL_SUSTAIN_S);
  return (ctx) => {
    const entryStats = ctx.edgeTrafficStats.find((s) => s.edgeId === BL_ENTRY);
    const hasTraffic = (entryStats?.vehicleCount ?? 0) > 0;
    const losOk = !!entryStats && LOS_C_OR_BETTER.has(entryStats.los);
    const sustainedS = sustain(ctx.simTimeS, hasTraffic && losOk);
    const won = sustainedS >= BL_SUSTAIN_S;

    return {
      won,
      label: `Entry corridor LOS C+ held ${Math.round(sustainedS)}s / ${BL_SUSTAIN_S}s`,
      detailLines: [
        `Entry corridor LOS: ${entryStats?.los ?? "—"} (need C or better, held ${BL_SUSTAIN_S}s straight)`,
        `Budget remaining: $${Math.max(0, Math.round(ctx.budgetRemaining)).toLocaleString()}`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 7. The Roundabout Mandate
// ---------------------------------------------------------------------------

const RM_ENTRY_W = "rmEntryW";
const RM_DEST_E = "rmDestE";
const RM_ENTRY_N = "rmEntryN";
const RM_DEST_S = "rmDestS";
const RM_SUSTAIN_S = 45;

const roundaboutMandateNetwork: NetworkSnapshot = {
  nodes: [
    node("rmC", 0, 0, 0),
    node("rmW", -400, 0, 0),
    node("rmE", 400, 0, 0),
    node("rmN", 0, 0, -400),
    node("rmS", 0, 0, 400),
  ],
  edges: [
    { id: RM_ENTRY_W, fromNodeId: "rmW", toNodeId: "rmC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 450 } },
    { id: RM_DEST_E, fromNodeId: "rmC", toNodeId: "rmE", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: 20 } },
    { id: RM_ENTRY_N, fromNodeId: "rmN", toNodeId: "rmC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 450 } },
    { id: RM_DEST_S, fromNodeId: "rmC", toNodeId: "rmS", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: 20 } },
  ] satisfies EdgeSpec[],
};

function createRoundaboutMandateEvaluator(): ScenarioEvaluator {
  const sustain = createSustainTracker(RM_SUSTAIN_S);
  return (ctx) => {
    const hasRoundabout = ctx.network.edges.some((e) => e.isRoundaboutRing);
    const w = ctx.edgeTrafficStats.find((s) => s.edgeId === RM_ENTRY_W);
    const n = ctx.edgeTrafficStats.find((s) => s.edgeId === RM_ENTRY_N);
    const allOk = hasRoundabout && !!w && LOS_C_OR_BETTER.has(w.los) && !!n && LOS_C_OR_BETTER.has(n.los);
    const sustainedS = sustain(ctx.simTimeS, allOk);
    const won = sustainedS >= RM_SUSTAIN_S;

    return {
      won,
      label: !hasRoundabout
        ? "No roundabout built yet 🔄"
        : `Both approaches LOS C+ held ${Math.round(sustainedS)}s / ${RM_SUSTAIN_S}s`,
      detailLines: [
        hasRoundabout ? "Roundabout detected ✓" : "This junction needs an actual roundabout, not just a signal.",
        `West approach LOS: ${w?.los ?? "—"}`,
        `North approach LOS: ${n?.los ?? "—"}`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 8. The Overpass Overhaul
// ---------------------------------------------------------------------------

const OO_ENTRY_W = "ooEntryW";
const OO_DEST_E = "ooDestE";
const OO_ENTRY_S = "ooEntryS";
const OO_DEST_N = "ooDestN";
const OO_SUSTAIN_S = 60;
const OO_TARGET_FLOW = 1600;

const overpassOverhaulNetwork: NetworkSnapshot = {
  nodes: [
    node("ooC", 0, 0, 0),
    node("ooW", -450, 0, 0),
    node("ooE", 450, 0, 0),
    node("ooS", 0, 0, 400),
    node("ooN", 0, 0, -400),
  ],
  edges: [
    { id: OO_ENTRY_W, fromNodeId: "ooW", toNodeId: "ooC", interiorPoints: [], roadClassId: "avenue", elevationLevelId: "ground", lanes: 2, laneWidthFt: 11, speedLimitMph: 40, zone: { type: "entry", demandVehPerHour: 1800 } },
    { id: OO_DEST_E, fromNodeId: "ooC", toNodeId: "ooE", interiorPoints: [], roadClassId: "avenue", elevationLevelId: "ground", lanes: 2, laneWidthFt: 11, speedLimitMph: 40, zone: { type: "destination", targetSpeedMph: 32 } },
    { id: OO_ENTRY_S, fromNodeId: "ooS", toNodeId: "ooC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 900 } },
    { id: OO_DEST_N, fromNodeId: "ooC", toNodeId: "ooN", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: 20 } },
  ] satisfies EdgeSpec[],
};

function createOverpassOverhaulEvaluator(): ScenarioEvaluator {
  const sustain = createSustainTracker(OO_SUSTAIN_S);
  return (ctx) => {
    const destEdge = ctx.network.edgesById.get(OO_DEST_E);
    const destStats = ctx.edgeTrafficStats.find((s) => s.edgeId === OO_DEST_E);
    const flowVehPerHour = destStats && destEdge ? destStats.flowPerLaneVehPerHour * destEdge.lanes : 0;
    const losOk = !!destStats && LOS_C_OR_BETTER.has(destStats.los);
    const noGridlock = ctx.gridlockMarkers.length === 0;
    const ok = flowVehPerHour >= OO_TARGET_FLOW && losOk && noGridlock;
    const sustainedS = sustain(ctx.simTimeS, ok);
    const won = sustainedS >= OO_SUSTAIN_S;

    return {
      won,
      label: `Mainline ${Math.round(flowVehPerHour)} veh/h · LOS ${destStats?.los ?? "—"} · held ${Math.round(sustainedS)}s / ${OO_SUSTAIN_S}s`,
      detailLines: [
        `Mainline flow: ${Math.round(flowVehPerHour)} / ${OO_TARGET_FLOW} veh/h`,
        `Mainline LOS: ${destStats?.los ?? "—"} (need C or better)`,
        noGridlock ? "No standstills." : "A vehicle is at a complete standstill somewhere on the network.",
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 9. The High Pass
// ---------------------------------------------------------------------------

const HP_ENTRY_ROAD = "hpEntryRoad";
const HP_DEST_ROAD = "hpDestRoad";
const HP_TARGET_FLOW_VEH_PER_HOUR = 600;
const HP_SUSTAIN_S = 30;

const highPassNetwork: NetworkSnapshot = {
  nodes: [
    node("hpN1", -500, 0, 0),
    node("hpN1b", -400, 0, 0),
    node("hpN2b", 400, 90, 0),
    node("hpN2", 500, 90, 0),
  ],
  edges: [
    { id: HP_ENTRY_ROAD, fromNodeId: "hpN1", toNodeId: "hpN1b", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 650 } },
    { id: HP_DEST_ROAD, fromNodeId: "hpN2b", toNodeId: "hpN2", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: 28 } },
  ] satisfies EdgeSpec[],
};

function createHighPassEvaluator(): ScenarioEvaluator {
  const sustain = createSustainTracker(HP_SUSTAIN_S);
  return (ctx) => {
    const overGradeCount = ctx.network.edges.filter((e) => {
      const from = ctx.network.nodesById.get(e.fromNodeId);
      const to = ctx.network.nodesById.get(e.toNodeId);
      return !!from && !!to && Math.abs(computeGradePercent(from.position, to.position)) > MAX_GRADE_PERCENT;
    }).length;

    const connected = computeRoute(ctx.network, HP_ENTRY_ROAD, HP_DEST_ROAD) !== null;

    const destEdge = ctx.network.edgesById.get(HP_DEST_ROAD);
    const destStats = ctx.edgeTrafficStats.find((s) => s.edgeId === HP_DEST_ROAD);
    const flowVehPerHour = destStats && destEdge ? destStats.flowPerLaneVehPerHour * destEdge.lanes : 0;
    const flowOk = flowVehPerHour >= HP_TARGET_FLOW_VEH_PER_HOUR;
    const losOk = !!destStats && LOS_B_OR_BETTER.has(destStats.los);

    const ok = connected && flowOk && losOk && overGradeCount === 0;
    const sustainedS = sustain(ctx.simTimeS, ok);
    const won = sustainedS >= HP_SUSTAIN_S;

    return {
      won,
      label: !connected
        ? "Not connected yet"
        : overGradeCount > 0
          ? `⚠ ${overGradeCount} segment${overGradeCount === 1 ? "" : "s"} over ${MAX_GRADE_PERCENT}% grade`
          : `${Math.round(flowVehPerHour)} veh/h · LOS ${destStats?.los ?? "—"} · held ${Math.round(sustainedS)}s / ${HP_SUSTAIN_S}s`,
      detailLines: [
        connected ? "Route connects both endpoints." : "Route does not yet connect both endpoints.",
        `Grade limit: ${overGradeCount === 0 ? "all segments within " + MAX_GRADE_PERCENT + "%" : overGradeCount + " segment(s) exceed " + MAX_GRADE_PERCENT + "%"}`,
        `Sustained flow: ${Math.round(flowVehPerHour)} / ${HP_TARGET_FLOW_VEH_PER_HOUR} veh/h at LOS ${destStats?.los ?? "—"} (need B or better)`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 10. Gridlock Alley
// ---------------------------------------------------------------------------

const GA_ENTRY_W = "gaEntryW";
const GA_DEST_E = "gaDestE";
const GA_ENTRY_S = "gaEntryS";
const GA_DEST_N = "gaDestN";
const GA_DURATION_S = 180;
const GA_TARGET_E_MPH = 22;
const GA_TARGET_N_MPH = 18;

const gridlockAlleyNetwork: NetworkSnapshot = {
  nodes: [
    node("gaC", 0, 0, 0),
    node("gaW", -350, 0, 0),
    node("gaE", 350, 0, 0),
    node("gaS", 0, 0, 300),
    node("gaN", 0, 0, -300),
  ],
  edges: [
    { id: GA_ENTRY_W, fromNodeId: "gaW", toNodeId: "gaC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 1400 } },
    { id: GA_DEST_E, fromNodeId: "gaC", toNodeId: "gaE", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: GA_TARGET_E_MPH } },
    { id: GA_ENTRY_S, fromNodeId: "gaS", toNodeId: "gaC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 800 } },
    { id: GA_DEST_N, fromNodeId: "gaC", toNodeId: "gaN", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: GA_TARGET_N_MPH } },
  ] satisfies EdgeSpec[],
};

function createGridlockAlleyEvaluator(): ScenarioEvaluator {
  let violated = false;
  let baselinePenalty: number | null = null;

  return (ctx) => {
    if (baselinePenalty === null) baselinePenalty = ctx.gridlockPenaltyTotal;
    if (ctx.gridlockMarkers.length > 0 || ctx.gridlockPenaltyTotal > baselinePenalty) violated = true;

    const runComplete = ctx.elapsedS >= GA_DURATION_S;
    const eDest = ctx.edgeTrafficStats.find((s) => s.edgeId === GA_DEST_E);
    const nDest = ctx.edgeTrafficStats.find((s) => s.edgeId === GA_DEST_N);
    const destinationsOk = !!eDest && eDest.avgSpeedMph >= GA_TARGET_E_MPH && !!nDest && nDest.avgSpeedMph >= GA_TARGET_N_MPH;

    const won = runComplete && !violated && destinationsOk;

    return {
      won,
      label: violated
        ? "A standstill happened somewhere — run is spoiled ❌"
        : `No standstills so far. East ${eDest ? Math.round(eDest.avgSpeedMph) : "—"}mph / North ${nDest ? Math.round(nDest.avgSpeedMph) : "—"}mph`,
      detailLines: [
        violated ? "A vehicle came to a complete standstill at some point during the run." : "No vehicle ever came to a complete standstill.",
        `East destination speed: ${eDest ? Math.round(eDest.avgSpeedMph) : "—"} mph (target ${GA_TARGET_E_MPH})`,
        `North destination speed: ${nDest ? Math.round(nDest.avgSpeedMph) : "—"} mph (target ${GA_TARGET_N_MPH})`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 11. The Motorway Merge
// ---------------------------------------------------------------------------

const MM_ENTRY = "mmEntry";
const MM_DEST = "mmDest";
const MM_TARGET_FLOW = 2800;
const MM_SUSTAIN_S = 60;

const motorwayMergeNetwork: NetworkSnapshot = {
  nodes: [node("mmN1", -550, 0, 0), node("mmN2", -200, 0, 0), node("mmN3", 200, 0, 0), node("mmN4", 550, 0, 0)],
  edges: [
    { id: MM_ENTRY, fromNodeId: "mmN1", toNodeId: "mmN2", interiorPoints: [], roadClassId: "highway", elevationLevelId: "ground", lanes: 1, laneWidthFt: 12, speedLimitMph: 55, zone: { type: "entry", demandVehPerHour: 3200 } },
    { id: MM_DEST, fromNodeId: "mmN3", toNodeId: "mmN4", interiorPoints: [], roadClassId: "highway", elevationLevelId: "ground", lanes: 1, laneWidthFt: 12, speedLimitMph: 55, zone: { type: "destination", targetSpeedMph: 45 } },
  ] satisfies EdgeSpec[],
};

function createMotorwayMergeEvaluator(): ScenarioEvaluator {
  const sustain = createSustainTracker(MM_SUSTAIN_S);
  return (ctx) => {
    const destEdge = ctx.network.edgesById.get(MM_DEST);
    const destStats = ctx.edgeTrafficStats.find((s) => s.edgeId === MM_DEST);
    const flowVehPerHour = destStats && destEdge ? destStats.flowPerLaneVehPerHour * destEdge.lanes : 0;
    const losOk = !!destStats && LOS_B_OR_BETTER.has(destStats.los);
    const ok = flowVehPerHour >= MM_TARGET_FLOW && losOk;
    const sustainedS = sustain(ctx.simTimeS, ok);
    const won = sustainedS >= MM_SUSTAIN_S;

    return {
      won,
      label: `${Math.round(flowVehPerHour)} veh/h · LOS ${destStats?.los ?? "—"} · held ${Math.round(sustainedS)}s / ${MM_SUSTAIN_S}s`,
      detailLines: [
        `Throughput: ${Math.round(flowVehPerHour)} / ${MM_TARGET_FLOW} veh/h`,
        `LOS: ${destStats?.los ?? "—"} (need B or better — this is a premium corridor)`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 12. Rush Hour Squeeze
// ---------------------------------------------------------------------------

const RS_ENTRY_W = "rsEntryW";
const RS_DEST_E = "rsDestE";
const RS_ENTRY_S = "rsEntryS";
const RS_DEST_N = "rsDestN";
const RS_DURATION_S = 120;
const RS_PEAK_WINDOW_S = 30;
const RS_TARGET_FLOW = 1800;

const rushHourSqueezeNetwork: NetworkSnapshot = {
  nodes: [
    node("rsC", 0, 0, 0),
    node("rsW", -420, 0, 0),
    node("rsE", 420, 0, 0),
    node("rsS", 0, 0, 380),
    node("rsN", 0, 0, -380),
  ],
  edges: [
    { id: RS_ENTRY_W, fromNodeId: "rsW", toNodeId: "rsC", interiorPoints: [], roadClassId: "avenue", elevationLevelId: "ground", lanes: 2, laneWidthFt: 11, speedLimitMph: 40, zone: { type: "entry", demandVehPerHour: 2000 } },
    { id: RS_DEST_E, fromNodeId: "rsC", toNodeId: "rsE", interiorPoints: [], roadClassId: "avenue", elevationLevelId: "ground", lanes: 2, laneWidthFt: 11, speedLimitMph: 40, zone: { type: "destination", targetSpeedMph: 30 } },
    { id: RS_ENTRY_S, fromNodeId: "rsS", toNodeId: "rsC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 1200 } },
    { id: RS_DEST_N, fromNodeId: "rsC", toNodeId: "rsN", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "destination", targetSpeedMph: 22 } },
  ] satisfies EdgeSpec[],
};

function createRushHourSqueezeEvaluator(): ScenarioEvaluator {
  let violated = false;
  let baselinePenalty: number | null = null;

  return (ctx) => {
    const windowStartS = Math.max(0, RS_DURATION_S - RS_PEAK_WINDOW_S);
    const inPeakWindow = ctx.elapsedS >= windowStartS;

    if (inPeakWindow) {
      if (baselinePenalty === null) baselinePenalty = ctx.gridlockPenaltyTotal;
      if (ctx.gridlockMarkers.length > 0 || ctx.gridlockPenaltyTotal > baselinePenalty) violated = true;
    }

    const destEdge = ctx.network.edgesById.get(RS_DEST_E);
    const destStats = ctx.edgeTrafficStats.find((s) => s.edgeId === RS_DEST_E);
    const flowVehPerHour = destStats && destEdge ? destStats.flowPerLaneVehPerHour * destEdge.lanes : 0;
    const losOk = !!destStats && LOS_C_OR_BETTER.has(destStats.los);
    const flowOk = flowVehPerHour >= RS_TARGET_FLOW;

    const runComplete = ctx.elapsedS >= RS_DURATION_S;
    const won = runComplete && inPeakWindow && !violated && flowOk && losOk;

    return {
      won,
      label: !inPeakWindow
        ? `Peak window begins at ${Math.round(windowStartS)}s`
        : violated
          ? "Standstill during the peak window ❌"
          : `${Math.round(flowVehPerHour)} veh/h · LOS ${destStats?.los ?? "—"} through the peak window`,
      detailLines: [
        violated ? "A vehicle stood completely still during the final peak window." : "No standstill during the final peak window.",
        `Mainline flow during peak: ${Math.round(flowVehPerHour)} / ${RS_TARGET_FLOW} veh/h`,
        `Mainline LOS: ${destStats?.los ?? "—"} (need C or better)`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// 13. The Grand Interchange
// ---------------------------------------------------------------------------

const GI_ENTRY_W = "giEntryW";
const GI_ENTRY_S = "giEntryS";
const GI_ENTRY_N = "giEntryN";
const GI_DEST_E = "giDestE";
const GI_DEST_SE = "giDestSE";
const GI_DURATION_S = 240;
const GI_FINAL_WINDOW_S = 60;
const GI_TARGET_FLOW_W = 2000;
const GI_TARGET_E_MPH = 42;
const GI_TARGET_SE_MPH = 30;

const grandInterchangeNetwork: NetworkSnapshot = {
  nodes: [
    node("giC", 0, 0, 0),
    node("giW", -480, 0, 0),
    node("giS", 0, 0, 420),
    node("giN", 0, 0, -420),
    node("giE", 480, 0, -120),
    node("giSE", 380, 0, 320),
  ],
  edges: [
    { id: GI_ENTRY_W, fromNodeId: "giW", toNodeId: "giC", interiorPoints: [], roadClassId: "highway", elevationLevelId: "ground", lanes: 2, laneWidthFt: 12, speedLimitMph: 55, zone: { type: "entry", demandVehPerHour: 2200 } },
    { id: GI_ENTRY_S, fromNodeId: "giS", toNodeId: "giC", interiorPoints: [], roadClassId: "avenue", elevationLevelId: "ground", lanes: 2, laneWidthFt: 11, speedLimitMph: 40, zone: { type: "entry", demandVehPerHour: 1200 } },
    { id: GI_ENTRY_N, fromNodeId: "giN", toNodeId: "giC", interiorPoints: [], roadClassId: "street", elevationLevelId: "ground", lanes: 1, laneWidthFt: 11, speedLimitMph: 30, zone: { type: "entry", demandVehPerHour: 800 } },
    { id: GI_DEST_E, fromNodeId: "giC", toNodeId: "giE", interiorPoints: [], roadClassId: "highway", elevationLevelId: "ground", lanes: 2, laneWidthFt: 12, speedLimitMph: 55, zone: { type: "destination", targetSpeedMph: GI_TARGET_E_MPH } },
    { id: GI_DEST_SE, fromNodeId: "giC", toNodeId: "giSE", interiorPoints: [], roadClassId: "avenue", elevationLevelId: "ground", lanes: 2, laneWidthFt: 11, speedLimitMph: 40, zone: { type: "destination", targetSpeedMph: GI_TARGET_SE_MPH } },
  ] satisfies EdgeSpec[],
};

function createGrandInterchangeEvaluator(): ScenarioEvaluator {
  let violated = false;
  let baselinePenalty: number | null = null;

  return (ctx) => {
    if (baselinePenalty === null) baselinePenalty = ctx.gridlockPenaltyTotal;
    if (ctx.gridlockMarkers.length > 0 || ctx.gridlockPenaltyTotal > baselinePenalty) violated = true;

    const windowStartS = Math.max(0, GI_DURATION_S - GI_FINAL_WINDOW_S);
    const inFinalWindow = ctx.elapsedS >= windowStartS;

    const wStats = ctx.edgeTrafficStats.find((s) => s.edgeId === GI_ENTRY_W);
    const wEdge = ctx.network.edgesById.get(GI_ENTRY_W);
    const wFlow = wStats && wEdge ? wStats.flowPerLaneVehPerHour * wEdge.lanes : 0;
    const wLosOk = !!wStats && LOS_B_OR_BETTER.has(wStats.los);

    const eDest = ctx.edgeTrafficStats.find((s) => s.edgeId === GI_DEST_E);
    const seDest = ctx.edgeTrafficStats.find((s) => s.edgeId === GI_DEST_SE);
    const destinationsOk = !!eDest && eDest.avgSpeedMph >= GI_TARGET_E_MPH && !!seDest && seDest.avgSpeedMph >= GI_TARGET_SE_MPH;

    const runComplete = ctx.elapsedS >= GI_DURATION_S;
    const finalOk = inFinalWindow && wFlow >= GI_TARGET_FLOW_W && wLosOk && destinationsOk;
    const won = runComplete && !violated && finalOk;

    return {
      won,
      label: violated
        ? "A standstill happened somewhere — run is spoiled ❌"
        : !inFinalWindow
          ? `Final review begins at ${Math.round(windowStartS)}s`
          : `West ${Math.round(wFlow)} veh/h · LOS ${wStats?.los ?? "—"}`,
      detailLines: [
        violated ? "A vehicle came to a complete standstill at some point during the run." : "No vehicle ever came to a complete standstill.",
        `West approach (heaviest): ${Math.round(wFlow)} / ${GI_TARGET_FLOW_W} veh/h at LOS ${wStats?.los ?? "—"} (need B or better)`,
        `East destination speed: ${eDest ? Math.round(eDest.avgSpeedMph) : "—"} mph (target ${GI_TARGET_E_MPH})`,
        `Southeast destination speed: ${seDest ? Math.round(seDest.avgSpeedMph) : "—"} mph (target ${GI_TARGET_SE_MPH})`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "first-shift",
    kind: "manage",
    name: "First Shift",
    tagline: "Your first day on the job. We'll walk you through it.",
    briefing:
      "A guided tour of the tools. Harbor Drive has one slow-posted block, one traffic light gone haywire, and a stretch where kids cross without a crossing. Fix the three, and the street flows. A step-by-step guide shows you where to click.",
    startingNetwork: FIRST_SHIFT_NETWORK,
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    createEvaluator: createSafeStreetsEvaluator(FIRST_SHIFT_PAR, 300),
  },
  {
    id: "suburban-choke-point",
    name: "The Suburban Choke Point",
    tagline: "Bridge the river between suburb and industrial park.",
    briefing:
      "A suburb on one bank needs to reach the industrial park on the other, and there's no crossing yet. Build a bridge or viaduct over the river, then keep the approach road flowing at LOS C or better for a full minute while moving 35 vehicles through.",
    startingNetwork: suburbanChokePointNetwork,
    startingBudget: 750_000,
    durationS: 150,
    targetAvgSpeedMph: 25,
    createEvaluator: createSuburbanChokePointEvaluator,
    terrainFeature: { kind: "river", x1: -150, z1: -500, x2: 150, z2: 500 },
  },
  {
    id: "bypassed-town",
    name: "The Bypassed Town (Texas Turnaround)",
    tagline: "An at-grade signal is choking the mainline. Grade-separate it.",
    briefing:
      "Through traffic and cross-street traffic both fight over one signalized junction, and it gridlocks every rush hour. Widen it, retime it, or bypass it entirely with an elevated mainline — just make sure nothing comes to a dead stop during the peak rush minute at the end of the run.",
    startingNetwork: bypassedTownNetwork,
    startingBudget: 1_400_000,
    durationS: BT_DURATION_S,
    targetAvgSpeedMph: 30,
    createEvaluator: createBypassedTownEvaluator,
  },
  {
    id: "mountain-cut",
    name: "The Mountain Cut",
    tagline: "Climb the cliff without exceeding a 6% grade.",
    briefing:
      "The valley floor sits 77 feet below the ridge, only 700 feet away as the crow flies — far too steep to drive directly. Use cuttings, viaducts, and tunnels (and however much winding road it takes) to connect both endpoints without any single segment exceeding a 6% grade, then sustain 400 vehicles/hour across it.",
    startingNetwork: mountainCutNetwork,
    startingBudget: 2_000_000,
    durationS: 150,
    targetAvgSpeedMph: 25,
    createEvaluator: createMountainCutEvaluator,
    terrainFeature: { kind: "cliff", x1: -350, z1: -600, x2: 350, z2: 600 },
  },
  {
    id: "five-points",
    name: "Five-Points Free-for-All",
    tagline: "An uncontrolled five-leg junction is a demolition derby.",
    briefing:
      "Five roads meet at one uncontrolled junction and everybody's fighting for the same gap. Add a signal, or convert it into a full roundabout, then hold LOS C or better on all three entry approaches at once for 45 seconds straight.",
    startingNetwork: fivePointsNetwork,
    startingBudget: 500_000,
    durationS: 150,
    targetAvgSpeedMph: 22,
    createEvaluator: createFivePointsEvaluator,
  },
  {
    id: "diverging-destinations",
    name: "The Diverging Destinations",
    tagline: "One road in, two very different roads out.",
    briefing:
      "A single approach has to split toward two destinations with very different speed targets — a fast branch and a slower local one. Connect the gap, size the fork so neither branch starves the other, and hold both branches at their target speed at once for 30 seconds.",
    startingNetwork: divergingDestinationsNetwork,
    startingBudget: 300_000,
    durationS: 150,
    targetAvgSpeedMph: 24,
    createEvaluator: createDivergingDestinationsEvaluator,
  },
  {
    id: "budget-lockdown",
    name: "Budget Lockdown",
    tagline: "Heavy demand, a shoestring budget. Build lean.",
    briefing:
      "1,600 vehicles an hour need to cross this gap and there is nowhere near enough money for anything fancy — widen only what actually needs it, on the cheapest road class that can carry the load, and hold LOS C or better for a full 90 seconds.",
    startingNetwork: budgetLockdownNetwork,
    startingBudget: 220_000,
    durationS: 150,
    targetAvgSpeedMph: 24,
    createEvaluator: createBudgetLockdownEvaluator,
  },
  {
    id: "roundabout-mandate",
    name: "The Roundabout Mandate",
    tagline: "Balanced four-way flow. A signal won't cut it here — build a roundabout.",
    briefing:
      "Traffic arrives evenly from every direction at this junction, which is exactly the case a roundabout is built for. This one specifically checks that you've actually built a roundabout ring (not just a signal), then requires LOS C or better on both entry approaches for 45 seconds straight.",
    startingNetwork: roundaboutMandateNetwork,
    startingBudget: 450_000,
    durationS: 150,
    targetAvgSpeedMph: 20,
    createEvaluator: createRoundaboutMandateEvaluator,
  },
  {
    id: "overpass-overhaul",
    name: "The Overpass Overhaul",
    tagline: "This crossing carries too much traffic for a shared signal.",
    briefing:
      "1,800 vehicles an hour on the mainline meet 900 more crossing it, and no signal timing can hold LOS C at this volume without one direction eating the delay. Grade-separate the mainline so it never has to stop for the cross street, then sustain 1,600 veh/h at LOS C or better with zero standstills for a full minute.",
    startingNetwork: overpassOverhaulNetwork,
    startingBudget: 1_800_000,
    durationS: 180,
    targetAvgSpeedMph: 32,
    createEvaluator: createOverpassOverhaulEvaluator,
  },
  {
    id: "high-pass",
    name: "The High Pass",
    tagline: "A steeper, longer climb than the Mountain Cut — and a stricter LOS bar.",
    briefing:
      "This pass gains 90 feet over a much shorter straight-line span than the Mountain Cut ever asked for, so a direct road blows well past the 6% grade limit. Wind it, cut it, tunnel it — whatever it takes — then sustain 600 vehicles/hour at LOS B or better for 30 seconds.",
    startingNetwork: highPassNetwork,
    startingBudget: 2_800_000,
    durationS: 180,
    targetAvgSpeedMph: 28,
    createEvaluator: createHighPassEvaluator,
    terrainFeature: { kind: "cliff", x1: -400, z1: -600, x2: 400, z2: 600 },
  },
  {
    id: "gridlock-alley",
    name: "Gridlock Alley",
    tagline: "No standstills allowed — for the entire run, not just the rush.",
    briefing:
      "This one doesn't give you a peak minute to survive — one dead-stopped vehicle anywhere on the network, at any point in the full three-minute run, spoils it. Build it robust from the first car to the last, and have both destinations still hitting their target speed when time runs out.",
    startingNetwork: gridlockAlleyNetwork,
    startingBudget: 900_000,
    durationS: GA_DURATION_S,
    targetAvgSpeedMph: 22,
    createEvaluator: createGridlockAlleyEvaluator,
  },
  {
    id: "motorway-merge",
    name: "The Motorway Merge",
    tagline: "3,200 vehicles an hour. Only the top road class will do.",
    briefing:
      "This corridor is starting life as a single undersized highway lane carrying 3,200 vehicles an hour it was never built for. Widen it, upgrade it to motorway if you have to — whatever gets 2,800 veh/h through at LOS B or better, sustained for a full minute. This is a premium corridor; congestion isn't acceptable.",
    startingNetwork: motorwayMergeNetwork,
    startingBudget: 2_500_000,
    durationS: 180,
    targetAvgSpeedMph: 45,
    createEvaluator: createMotorwayMergeEvaluator,
  },
  {
    id: "rush-hour-squeeze",
    name: "Rush Hour Squeeze",
    tagline: "Big-city demand, small-town budget, and no time to iterate.",
    briefing:
      "2,000 vehicles an hour on the mainline, 1,200 more crossing it, a budget that won't cover overbuilding, and a run that's over in two minutes. In the final 30 seconds you need 1,800 veh/h at LOS C or better on the mainline with zero standstills anywhere — there's no room here for a wasteful design.",
    startingNetwork: rushHourSqueezeNetwork,
    startingBudget: 1_300_000,
    durationS: RS_DURATION_S,
    targetAvgSpeedMph: 30,
    createEvaluator: createRushHourSqueezeEvaluator,
  },
  {
    id: "grand-interchange",
    name: "The Grand Interchange",
    tagline: "Everything you've learned, all at once. The campaign's final exam.",
    briefing:
      "Three entries, two destinations, one interchange. 2,200 veh/h come in on the heaviest approach alone. Build it so nothing ever comes to a complete standstill across the full four-minute run, and in the final minute hold the heaviest approach at LOS B or better carrying 2,000 veh/h while both destinations sit at their target speed.",
    startingNetwork: grandInterchangeNetwork,
    startingBudget: 3_200_000,
    durationS: GI_DURATION_S,
    targetAvgSpeedMph: 38,
    createEvaluator: createGrandInterchangeEvaluator,
  },
  {
    id: "highway-interchange",
    name: "Interchange Builder",
    tagline: "Two motorways that don't meet. Make them.",
    briefing:
      "Two motorways stop short of each other, so nothing can get from the west or south to the east or north until you connect them. A plain junction will clog under this much traffic. Fly one road over the other with a bridge or viaduct, add ramps for the turns, and keep budget in mind: elevated road is expensive.",
    startingNetwork: INTERCHANGE_NETWORK,
    startingBudget: 2_000_000,
    durationS: 260,
    targetAvgSpeedMph: 45,
    createEvaluator: createTripsEvaluator(225),
  },
  {
    id: "clover-crossing",
    name: "Clover Crossing",
    tagline: "A cloverleaf with four loops, four weaves and no traffic light to hide behind.",
    briefing:
      "A freeway interchange of our own design: the north-south freeway climbs over the east-west one, every left turn is a tight loop and every right turn swings around the outside. Each loop ends where the next one begins, so the cars have only a thousand feet to weave across each other. Add lanes where the weaves choke, lower the loop limits so they merge calmly, or raise the mainlines, and keep the whole thing flowing.",
    startingNetwork: CLOVERLEAF_NETWORK,
    startingBudget: 6_000_000,
    durationS: 300,
    targetAvgSpeedMph: 40,
    // A semi dies in a freeway lane and a load comes off a truck; a wrecker (tap the pin) clears them far sooner than waiting.
    scriptedEvents: [
      { atS: 70, kind: "stall" },
      { atS: 150, kind: "debris" },
    ],
    createEvaluator: createRealCityEvaluator(CLOVER_BASELINE, 300),
  },
  {
    id: "continuous-flow",
    name: "Continuous Flow",
    tagline: "Half the cars turn left, and each one waits for a gap.",
    briefing:
      "Two avenues cross at one big signal. Half the cars turn left, and on a green every left turn gives way to the oncoming traffic, so a few of them hold up everyone behind. Displace the left turns ahead of the junction (the Junctions tool, Continuous flow): they cross over to the far side of the road a little before the light and run with the through traffic, so nobody waits for a gap. It costs money and room, so use it where it pays.",
    startingNetwork: LEFT_TURN_NETWORK,
    startingBudget: 2_500_000,
    durationS: 300,
    targetAvgSpeedMph: 25,
    leftTurnsYield: true,
    createEvaluator: createRealCityEvaluator(CONTINUOUS_FLOW_BASELINE, 300, 1.1, 1.05),
  },
  {
    id: "midtown",
    kind: "manage",
    name: "Midtown Meltdown",
    tagline: "The city is built. The traffic is not working.",
    briefing:
      "Four signals, eight ways in, and three things wrong. One avenue is posted at a crawl, one light flips too fast to move anyone, and two approaches waste a lane on left turns. You can't build anything: use lane arrows, speed limits and junction timing while traffic runs.",
    startingNetwork: MIDTOWN_NETWORK,
    startingBudget: 1000000,
    durationS: 300,
    targetAvgSpeedMph: 24,
    createEvaluator: createSpeedHoldEvaluator({ warmupS: 140, minMph: 17.5, holdS: 30 }),
  },
  {
    id: "harbor-drive",
    kind: "manage",
    name: "Harbor Drive",
    tagline: "Five lights in a row, and the waterfront is crawling.",
    briefing:
      "One long avenue, five signalized cross streets, and traffic that never gets going. A block of the avenue is posted far too slow, two lights flip green-to-red every few seconds, and three approaches waste a lane on left turns. Fix what you find while the cars keep moving.",
    startingNetwork: HARBOR_NETWORK,
    startingBudget: 1000000,
    durationS: 300,
    targetAvgSpeedMph: 26,
    createEvaluator: createTripsEvaluator(207),
  },
  {
    id: "game-night",
    kind: "manage",
    name: "Game Night",
    tagline: "The stadium lets out and everyone drives at once.",
    briefing:
      "Midtown again, but at 90 seconds the game ends and demand surges 80% for over a minute. Fix the city's faults, then keep it flowing through the rush. This is a score challenge: every vehicle that gets through counts, and stars measure you against a fully fixed city.",
    startingNetwork: MIDTOWN_NETWORK,
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    scriptedEvents: SURGE_NIGHT,
    createEvaluator: createChallengeEvaluator(527, 300),
  },
  {
    id: "rough-morning",
    kind: "manage",
    name: "Rough Morning",
    tagline: "Three cars break down at the worst possible places.",
    briefing:
      "Midtown, with three breakdowns that each block a lane for 18 seconds. A good layout recovers fast: spare lanes, sensible limits and signals that keep the queue from locking up. Score challenge: vehicles moved against a fully fixed city.",
    startingNetwork: MIDTOWN_NETWORK,
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    scriptedEvents: ROUGH_MORNING,
    createEvaluator: createChallengeEvaluator(514, 300),
  },
  {
    id: "code-three",
    kind: "manage",
    name: "Code Three",
    tagline: "Four ambulances. Every second counts.",
    briefing:
      "Midtown, with four ambulance calls at fixed moments. Ambulances run red lights and everyone pulls over for them, but they cannot drive through a jam. Clear the avenues they use: sensible limits, signals that don't choke the grid, and a reserved bus lane they can use as a fast lane. Scored on how close each trip gets to an empty road.",
    startingNetwork: MIDTOWN_NETWORK,
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    scriptedEvents: CODE_THREE_EVENTS,
    createEvaluator: createEmergencyEvaluator(4, CODE_THREE_RATIO, 300),
  },
  {
    id: "pile-up",
    kind: "manage",
    name: "Pile-Up",
    tagline: "Four crashes. Police can only clear what they can reach.",
    briefing:
      "Midtown, with four crashes at fixed moments. Each blocks a lane until a police car drives there and clears it, so the worse the traffic, the longer the wreck stays. Get the avenues moving so the police can get through, and keep the queues from locking up. Scored on how fast the crashes are cleared.",
    startingNetwork: MIDTOWN_NETWORK,
    startingBudget: 1_000_000,
    durationS: 330,
    targetAvgSpeedMph: 20,
    scriptedEvents: PILE_UP_EVENTS,
    createEvaluator: createCrashEvaluator(4, 330),
  },
  {
    id: "rainy-rush",
    kind: "manage",
    name: "Rainy Rush Hour",
    tagline: "It's pouring, and everyone is going home at once.",
    briefing:
      "Harbor Drive in a downpour. Rain slows every driver and makes them leave more room, then rush hour hits on top. Fix what's broken first: the faults that cost you in the dry cost you double in the wet. Score challenge: vehicles moved against a fully fixed street.",
    startingNetwork: HARBOR_NETWORK,
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    scriptedEvents: RAINY_EVENTS,
    createEvaluator: createChallengeEvaluator(RAINY_PAR, 300),
  },
  {
    id: "transit-street",
    kind: "manage",
    name: "Transit Street",
    tagline: "A bus holds forty people. A car holds one.",
    briefing:
      "Midtown's avenues carry buses and bicycles as well as cars. Reserve a lane for buses and the riders move faster, but cars have less road. Find the balance. This level counts people moved, not vehicles, so a full bus is worth far more than a car.",
    startingNetwork: TRANSIT_NETWORK,
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    trafficMix: { bus: 0.16, bike: 0.04 },
    createEvaluator: createPeopleEvaluator(TRANSIT_BASELINE_PEOPLE, 300),
  },
  {
    id: "school-run",
    kind: "manage",
    name: "School Run",
    tagline: "Kids cross wherever they like. Fix that before someone gets hurt.",
    briefing:
      "Two blocks of Harbor Drive sit by a school, and children cross wherever they please, stepping out in front of cars. Add marked crossings there, then fix the rest of the street so the added stops don't jam it. Score challenge: nobody steps into traffic, and traffic still keeps up.",
    startingNetwork: SCHOOL_NETWORK,
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    createEvaluator: createSafeStreetsEvaluator(SCHOOL_PAR, 300),
  },
  ...REAL_SCENARIOS,
];

// ---------------------------------------------------------------------------
// Custom challenges: a city someone built (and a score to beat) that arrives in a link, or that the player has just
// turned their own layout into. They are registered here under their own id so the rest of the game can find them.
// ---------------------------------------------------------------------------

export const CHALLENGE_PREFIX = "challenge-";
const customScenarios = new Map<string, ScenarioDef>();

/** Scores a run against a target: 3 stars for matching it, 2 for getting within 10%. With no target it just records the score to beat. */
function createBeatEvaluator(target: number, durationS: number): () => ScenarioEvaluator {
  return () => (ctx) => {
    const moved = ctx.completedTripsTotal;
    const stars: 1 | 2 | 3 = target <= 0 ? 3 : moved >= target ? 3 : moved >= target * 0.9 ? 2 : 1;
    return {
      won: ctx.elapsedS >= durationS - 0.5,
      stars,
      score: moved,
      label: target > 0 ? `${moved} moved · to beat ${target}` : `${moved} moved · set the bar`,
      detailLines: [
        `Vehicles moved: ${moved}`,
        target > 0 ? `Score to beat: ${target}` : "This is the score your friends will try to beat",
        `Gridlock penalties: ${ctx.gridlockPenaltyTotal}`,
      ],
    };
  };
}

/** Builds (and registers) a challenge level from a city and a target score. A target of 0 means "play it once to set the bar". */
export function buildChallengeScenario(opts: { key: string; name: string; network: NetworkSnapshot; target: number; from?: string }): ScenarioDef {
  const id = `${CHALLENGE_PREFIX}${opts.key}`;
  const def: ScenarioDef = {
    id,
    kind: "manage",
    name: opts.name,
    tagline: opts.target > 0 ? `${opts.from ? `${opts.from} moved` : "Moved"} ${opts.target} here. Can you beat it?` : "Your city, as a challenge.",
    briefing:
      opts.target > 0
        ? `A city ${opts.from ? `shared by ${opts.from}` : "shared with you"}. The roads are fixed: fix how traffic flows with lane arrows, speed limits, signals, bus lanes and crossings. Move more than ${opts.target} vehicles in five minutes to beat the score.`
        : "Play your city once, from the roads you built, to set a score. Then send it to a friend to beat. The roads are locked while you play.",
    startingNetwork: opts.network,
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    createEvaluator: createBeatEvaluator(opts.target, 300),
  };
  customScenarios.set(id, def);
  return def;
}

export function getScenarioById(id: string): ScenarioDef | undefined {
  if (id.startsWith(CHALLENGE_PREFIX)) return customScenarios.get(id);
  if (id.startsWith(DAILY_PREFIX)) return buildDailyScenario(id.slice(DAILY_PREFIX.length));
  return SCENARIOS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Daily challenge: a new Midtown variant every calendar day, the same for everyone
// ---------------------------------------------------------------------------

export const DAILY_PREFIX = "daily-";

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dailyCache = new Map<string, ScenarioDef>();

/** Par (vehicles moved in 300 s by a fully fixed Midtown) for each kind of trouble, measured in the headless sim. */
const DAILY_PAR = { none: 520, surge: 527, breakdowns: 514 } as const;

/**
 * Builds the day's challenge from its date alone, so everyone gets the same one with no server: which of Midtown's
 * faults are present (the slow limits always are, since they matter most), and what trouble arrives mid-run.
 */
export function buildDailyScenario(dateKey: string): ScenarioDef {
  const cached = dailyCache.get(dateKey);
  if (cached) return cached;

  const rng = seededRng(hashString(`road-constructor:${dateKey}`));
  let signal = rng() < 0.7;
  let arrows = rng() < 0.7;
  if (!signal && !arrows) signal = true;
  const trouble = (["none", "surge", "breakdowns"] as const)[Math.floor(rng() * 3)];
  const par = DAILY_PAR[trouble];

  const weekday = new Date(`${dateKey}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
  const nouns = ["Gridlock", "Meltdown", "Madness", "Crawl", "Pile-up", "Standstill"];
  const noun = nouns[Math.floor(rng() * nouns.length)];

  const faults = ["a slow-posted block", ...(signal ? ["a badly timed light"] : []), ...(arrows ? ["wasted turn lanes"] : [])];
  const troubleText =
    trouble === "surge"
      ? " Halfway through, a surge adds 80% more traffic."
      : trouble === "breakdowns"
        ? " Three cars will break down mid-run."
        : " No surprises, just the city itself.";

  const def: ScenarioDef = {
    id: `${DAILY_PREFIX}${dateKey}`,
    kind: "manage",
    name: `${weekday} ${noun}`,
    tagline: "Today's challenge: the same for everyone.",
    briefing: `Midtown with ${faults.join(", ")}.${troubleText} Move as many vehicles as you can in five minutes; stars compare you to a fully fixed city.`,
    startingNetwork: buildMidtown({ speed: true, signal, arrows }),
    startingBudget: 1_000_000,
    durationS: 300,
    targetAvgSpeedMph: 20,
    scriptedEvents: trouble === "surge" ? SURGE_NIGHT : trouble === "breakdowns" ? ROUGH_MORNING : undefined,
    createEvaluator: createChallengeEvaluator(par, 300),
  };
  dailyCache.set(dateKey, def);
  return def;
}
