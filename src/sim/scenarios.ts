import type { EdgeSpec, NetworkSnapshot, NodeSpec, RoadNetwork } from "./types";
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
  createEvaluator: () => ScenarioEvaluator;
  /** Decorative-only terrain dressing for the scenario's narrative (a river to bridge, a cliff to cut through). */
  terrainFeature?: { kind: "river" | "cliff"; x1: number; z1: number; x2: number; z2: number };
}

export interface ScenarioResult {
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

export function finalizeScenario(
  scenario: ScenarioDef,
  won: boolean,
  ctx: { avgSpeedMph: number; budgetRemaining: number },
  summaryLines: string[]
): ScenarioResult {
  const budgetRemainingFraction = ctx.budgetRemaining / scenario.startingBudget;
  return {
    won,
    stars: won ? computeStars(budgetRemainingFraction, ctx.avgSpeedMph, scenario.targetAvgSpeedMph) : 0,
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
];

export function getScenarioById(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
