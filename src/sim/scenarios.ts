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
  nodes: [node("sN1", -260, 0), node("sN2", 0, 0), node("sN3", 260, 0)],
  edges: [
    {
      id: "sE1",
      fromNodeId: "sN1",
      toNodeId: "sN2",
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
      toNodeId: "sN3",
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
      zone: { type: "entry", demandVehPerHour: 500 },
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
      zone: { type: "entry", demandVehPerHour: 500 },
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
      zone: { type: "entry", demandVehPerHour: 400 },
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
      zone: { type: "entry", demandVehPerHour: 500 },
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
      zone: { type: "entry", demandVehPerHour: 500 },
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
      zone: { type: "destination", targetSpeedMph: 45 },
    },
  ] satisfies EdgeSpec[],
};

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "bottleneck-alley",
    name: "Bottleneck Alley",
    tagline: "One skinny street, way too many cars.",
    briefing:
      "A single one-lane street can't keep up with entry demand. Widen it, add lanes, or route around the jam — whatever gets cars through at a decent clip before time's up.",
    startingNetwork: bottleneckAlley,
    startingBudget: 300_000,
    durationS: 75,
    targetThroughputPerMinute: 12,
    targetAvgSpeedMph: 25,
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
      "Traffic from two ramps has to merge cleanly onto the highway and stay fast all the way to the destination. Smooth the merge point and keep speeds up.",
    startingNetwork: highwayMerge,
    startingBudget: 400_000,
    durationS: 100,
    targetThroughputPerMinute: 20,
    targetAvgSpeedMph: 45,
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

  const score = Math.round(40 * throughputScore + 25 * speedScore + 25 * contractFraction + 10 * budgetScore);

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
