import type { EdgeSpec, NetworkSnapshot, NodeSpec, RoadNetwork } from "./types";
import type { EdgeTrafficStats } from "./los";
import { computeRoute } from "./network";
import { computeGradePercent, MAX_GRADE_PERCENT } from "./grade";

/** A generous, JSON-safe stand-in for "infinite" budget in Sandbox Mode — plain `Infinity` doesn't survive JSON persistence. */
export const SANDBOX_BUDGET = 999_999_999;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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
];

export function getScenarioById(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
