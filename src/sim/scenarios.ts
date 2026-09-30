import { buildHarborDrive, buildInterchangeSite, buildMidtown, buildOldTown } from "./cities";
import type { ContractStatus, EdgeSpec, NetworkSnapshot, NodeSpec } from "./types";

/** A built-in campaign scenario: a starting layout, a budget, a time limit, and score targets. */
export interface ScenarioDef {
  id: string;
  name: string;
  tagline: string;
  briefing: string;
  startingNetwork: NetworkSnapshot;
  startingBudget: number;
  durationS: number;
  targetThroughputPerMinute: number;
  targetAvgSpeedMph: number;
  /**
   * "manage" levels start from a finished city and lock building: the roads are fixed and the player fixes the
   * flow with lane arrows, speed limits and junction control. Undefined = a normal build-and-fix level.
   */
  kind?: "manage";
}

export interface ScenarioResult {
  score: number;
  avgSpeedMph: number;
  throughputPerMinute: number;
  budgetSpent: number;
  budgetRemaining: number;
  contractsMet: number;
  contractsTotal: number;
}

function node(id: string, x: number, z: number): NodeSpec {
  return { id, position: [x, 0, z] };
}

const bottleneckAlley: NetworkSnapshot = {
  nodes: [node("sN1", 0, -220), node("sN2", -220, 0), node("sN3", 0, 0), node("sN4", 220, 0)],
  edges: [
    {
      id: "sE1",
      fromNodeId: "sN1",
      toNodeId: "sN3",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 1000 },
    },
    {
      id: "sE2",
      fromNodeId: "sN2",
      toNodeId: "sN3",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 1000 },
    },
    {
      id: "sE3",
      fromNodeId: "sN3",
      toNodeId: "sN4",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "destination", targetSpeedMph: 20 },
    },
  ] satisfies EdgeSpec[],
};

const fourWayRush: NetworkSnapshot = {
  nodes: [
    node("sN0", 0, 0),
    node("sN1", 0, -240),
    node("sN2", -240, 0),
    node("sN3", 0, 240),
    node("sN4", 240, 0),
  ],
  edges: [
    {
      id: "sE1",
      fromNodeId: "sN1",
      toNodeId: "sN0",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 900 },
    },
    {
      id: "sE2",
      fromNodeId: "sN2",
      toNodeId: "sN0",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 900 },
    },
    {
      id: "sE3",
      fromNodeId: "sN3",
      toNodeId: "sN0",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 700 },
    },
    {
      id: "sE4",
      fromNodeId: "sN0",
      toNodeId: "sN4",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "destination", targetSpeedMph: 20 },
    },
  ] satisfies EdgeSpec[],
};

const highwayMerge: NetworkSnapshot = {
  nodes: [node("sN1", -320, -60), node("sN2", -320, 60), node("sN3", -100, 0), node("sN4", 300, 0)],
  edges: [
    {
      id: "sE1",
      fromNodeId: "sN1",
      toNodeId: "sN3",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 1400 },
    },
    {
      id: "sE2",
      fromNodeId: "sN2",
      toNodeId: "sN3",
      interiorPoints: [],
      roadClassId: "street",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: 11,
      speedLimitMph: 30,
      zone: { type: "entry", demandVehPerHour: 1400 },
    },
    {
      id: "sE3",
      fromNodeId: "sN3",
      toNodeId: "sN4",
      interiorPoints: [],
      roadClassId: "highway",
      elevationLevelId: "ground",
      lanes: 2,
      laneWidthFt: 12,
      speedLimitMph: 55,
      zone: { type: "destination", targetSpeedMph: 30 },
    },
  ] satisfies EdgeSpec[],
};

const MIDTOWN_NETWORK = buildMidtown(true);
const HARBOR_NETWORK = buildHarborDrive(true);
const OLD_TOWN_NETWORK = buildOldTown(true);
const INTERCHANGE_NETWORK = buildInterchangeSite();

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "bottleneck-alley",
    name: "Bottleneck Alley",
    tagline: "Two streets merge into one skinny lane.",
    briefing:
      "Two side streets dump straight into one skinny lane with no signal — it gridlocks fast. Add a signal, try a roundabout, or widen the shared stretch to keep cars moving.",
    startingNetwork: bottleneckAlley,
    startingBudget: 300_000,
    durationS: 90,
    targetThroughputPerMinute: 12,
    targetAvgSpeedMph: 12,
  },
  {
    id: "four-way-rush",
    name: "Four-Way Rush",
    tagline: "Three streets in, one way out, zero signals.",
    briefing:
      "Rush hour at an unsignalized crossroads. Add a signal, try a roundabout, or upgrade the exit — just stop everyone from grinding to a halt.",
    startingNetwork: fourWayRush,
    startingBudget: 250_000,
    durationS: 90,
    targetThroughputPerMinute: 18,
    targetAvgSpeedMph: 18,
  },
  {
    id: "highway-merge",
    name: "Highway Merge",
    tagline: "Two ramps merging onto one fast highway.",
    briefing:
      "Drivers cruise at whatever speed they picked up entering the network, so a slow ramp means a slow highway. Upgrade the ramps to a faster road class before they merge, then smooth the merge point itself.",
    startingNetwork: highwayMerge,
    startingBudget: 400_000,
    durationS: 100,
    targetThroughputPerMinute: 20,
    targetAvgSpeedMph: 45,
  },
  {
    id: "highway-interchange",
    name: "Interchange Builder",
    tagline: "Two motorways that don't meet. Make them.",
    briefing:
      "Two motorways stop short of each other, so nothing can get from the west or south to the east or north until you connect them. A plain junction will clog under this much traffic. Fly one road over the other with a bridge or viaduct, add ramps for the turns, and keep budget in mind: elevated road is expensive.",
    startingNetwork: INTERCHANGE_NETWORK,
    startingBudget: 2_000_000,
    durationS: 120,
    targetThroughputPerMinute: 78,
    targetAvgSpeedMph: 50,
  },
  {
    id: "midtown",
    kind: "manage",
    name: "Midtown Meltdown",
    tagline: "The city is built. The traffic is not working.",
    briefing:
      "Four signals, eight ways in, and three things wrong. One avenue is posted at a crawl, one light flips too fast to move anyone, and two approaches waste a lane on left turns. You can't build anything: use lane arrows, speed limits and junction timing while traffic runs.",
    startingNetwork: MIDTOWN_NETWORK,
    startingBudget: 0,
    durationS: 180,
    targetThroughputPerMinute: 135,
    targetAvgSpeedMph: 22,
  },
  {
    id: "harbor-drive",
    kind: "manage",
    name: "Harbor Drive",
    tagline: "Five lights in a row, and the waterfront is crawling.",
    briefing:
      "One long avenue, five signalized cross streets, and traffic that never gets going. A block of the avenue is posted far too slow, two lights flip green-to-red every few seconds, and three approaches waste a lane on left turns. Fix what you find while the cars keep moving.",
    startingNetwork: HARBOR_NETWORK,
    startingBudget: 0,
    durationS: 180,
    targetThroughputPerMinute: 66,
    targetAvgSpeedMph: 26,
  },
  {
    id: "old-town",
    kind: "manage",
    name: "Old Town",
    tagline: "Every corner has a traffic light. Every light is wrong.",
    briefing:
      "A tight grid of narrow streets where four corner lights flip every three seconds and spend their lives on clearance. Retime them, or ask whether a corner needs a light at all: switching a junction to priority can move more cars than a bad signal.",
    startingNetwork: OLD_TOWN_NETWORK,
    startingBudget: 0,
    durationS: 180,
    targetThroughputPerMinute: 88,
    targetAvgSpeedMph: 15,
  },
];

export function getScenarioById(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function scoreScenario(
  scenario: ScenarioDef,
  metrics: { avgSpeedMph: number; throughputPerMinute: number; contracts: ContractStatus[] },
  budgetRemaining: number
): ScenarioResult {
  const contractsTotal = metrics.contracts.length;
  const contractsMet = metrics.contracts.filter((c) => c.meetsThreshold).length;
  const contractFraction = contractsTotal > 0 ? contractsMet / contractsTotal : 1;

  const throughputScore = Math.min(1, metrics.throughputPerMinute / scenario.targetThroughputPerMinute);
  const speedScore = Math.min(1, metrics.avgSpeedMph / scenario.targetAvgSpeedMph);
  const budgetScore = Math.min(1, Math.max(0, budgetRemaining) / scenario.startingBudget);

  // Nothing is ever spent in a manage level, so budget is worthless there, and its destination targets are
  // trivially met; flow speed carries the score. Cubing each ratio makes doing nothing score poorly and
  // fixing the obvious faults score well, with headroom above that for real tuning.
  const score =
    scenario.kind === "manage"
      ? Math.round(30 * throughputScore ** 3 + 70 * speedScore ** 3)
      : Math.round(40 * throughputScore + 25 * speedScore + 25 * contractFraction + 10 * budgetScore);

  return {
    score,
    avgSpeedMph: metrics.avgSpeedMph,
    throughputPerMinute: metrics.throughputPerMinute,
    budgetSpent: scenario.startingBudget - budgetRemaining,
    budgetRemaining,
    contractsMet,
    contractsTotal,
  };
}
