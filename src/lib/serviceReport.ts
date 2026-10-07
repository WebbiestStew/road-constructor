import type { ScenarioDef } from "@/sim/scenarios";
import type { SimMetricsState } from "@/hooks/useTrafficSimulation";

/**
 * The service report: how well the city served its people, beyond how many vehicles got through. A level's stars
 * stay about its own goal; the medals below are the quality bar every run is also held to. Each medal has its own
 * "does it apply" test, so a level with no pedestrians never asks for safe crossings.
 */

export interface ServiceReport {
  /** Average seconds a car or truck lost against an empty road, per trip. Null before enough trips finished. */
  avgDelayS: number | null;
  /** Lost time as a share of the trip time on an empty road (0.4 = trips took 40% longer than they needed to). */
  delayShare: number | null;
  queuePeakFt: number;
  pedServed: number;
  pedIncidents: number;
  crashesHappened: number;
  crashesOpen: number;
  gridlockPenalties: number;
  combos: number;
  medals: Medal[];
}

export type MedalId = "delay" | "queue" | "peds" | "clear" | "gridlock" | "flow" | "buses";

export interface Medal {
  id: MedalId;
  icon: string;
  label: string;
  /** What it asks for, and what the run did. */
  detail: string;
  earned: boolean;
}

/** Fewest finished trips before the delay average means anything. */
export const MIN_TIMED_TRIPS = 25;
/** The delay and queue medals ask for this much better than the level's unchanged city. */
export const DELAY_MEDAL_RATIO = 0.9;
export const QUEUE_MEDAL_RATIO = 0.85;
export const MIN_PEDS_FOR_MEDAL = 3;
export const FLOW_COMBOS_FOR_MEDAL = 3;
/** Line-bus stops served before the spacing means anything, and the most the gaps may vary (spread = standard deviation / mean). */
export const MIN_BUS_SERVICES = 12;
export const MAX_BUS_HEADWAY_CV = 0.45;

export const MEDAL_META: Record<MedalId, { icon: string; label: string }> = {
  delay: { icon: "⏱️", label: "Less waiting" },
  queue: { icon: "🚗", label: "Short queues" },
  peds: { icon: "🚶", label: "Safe crossings" },
  clear: { icon: "🚧", label: "Clear roads" },
  gridlock: { icon: "🟢", label: "No gridlock" },
  flow: { icon: "🌊", label: "Green wave" },
  buses: { icon: "🚌", label: "Even service" },
};

/** The slice of a run's numbers the report reads: the live metrics, or the final tick of a headless run. */
export type ServiceInput = Pick<
  SimMetricsState,
  | "tripDelayTotalS"
  | "tripFreeFlowTotalS"
  | "tripsTimed"
  | "queuePeakFt"
  | "pedServedTotal"
  | "pedIncidentsTotal"
  | "crashes"
  | "gridlockPenaltyTotal"
  | "combos"
  | "transit"
>;

export function buildServiceReport(m: ServiceInput, baseline?: ScenarioDef["serviceBaseline"]): ServiceReport {
  const enough = m.tripsTimed >= MIN_TIMED_TRIPS && m.tripFreeFlowTotalS > 0;
  const delayShare = enough ? m.tripDelayTotalS / m.tripFreeFlowTotalS : null;
  const avgDelayS = enough ? m.tripDelayTotalS / m.tripsTimed : null;
  const medals: Medal[] = [];
  const add = (id: MedalId, earned: boolean, detail: string) => medals.push({ id, ...MEDAL_META[id], earned, detail });

  if (baseline && delayShare !== null) {
    const goal = baseline.delayShare * DELAY_MEDAL_RATIO;
    add("delay", delayShare <= goal, `Trips ${pct(delayShare)} over an empty road (goal ${pct(goal)}, the unchanged city ${pct(baseline.delayShare)})`);
  }
  if (baseline) {
    const goal = Math.round(baseline.queueFt * QUEUE_MEDAL_RATIO);
    add("queue", m.queuePeakFt <= goal, `Longest queue ${Math.round(m.queuePeakFt)} ft (goal ${goal} ft, the unchanged city ${Math.round(baseline.queueFt)} ft)`);
  }
  if (m.pedServedTotal >= MIN_PEDS_FOR_MEDAL) {
    add("peds", m.pedIncidentsTotal === 0, m.pedIncidentsTotal === 0 ? `${m.pedServedTotal} people crossed, nobody stepped into traffic` : `${m.pedIncidentsTotal} stepped into traffic (${m.pedServedTotal} crossed)`);
  }
  if (m.crashes.happened > 0) {
    const open = m.crashes.open;
    add("clear", open === 0 && m.crashes.cleared >= m.crashes.happened, `${m.crashes.cleared} of ${m.crashes.happened} crashes cleared${open > 0 ? `, ${open} still blocking` : ""}`);
  }
  add("gridlock", m.gridlockPenaltyTotal === 0, m.gridlockPenaltyTotal === 0 ? "Nobody was stuck long enough to be towed away" : `${m.gridlockPenaltyTotal} stuck for good`);
  if (m.combos > 0) {
    add("flow", m.combos >= FLOW_COMBOS_FOR_MEDAL, `${m.combos} flow combo${m.combos === 1 ? "" : "s"} (${FLOW_COMBOS_FOR_MEDAL} for the medal)`);
  }

  if (m.transit.services >= MIN_BUS_SERVICES) {
    add("buses", m.transit.headwayCv <= MAX_BUS_HEADWAY_CV, `Buses came every ${Math.round(m.transit.headwayMeanS)} s with a spread of ${m.transit.headwayCv.toFixed(2)} (${MAX_BUS_HEADWAY_CV} or less for the medal)${m.transit.transfers > 0 ? `, ${m.transit.transfers} people changed lines` : ""}`);
  }

  return {
    avgDelayS,
    delayShare,
    queuePeakFt: m.queuePeakFt,
    pedServed: m.pedServedTotal,
    pedIncidents: m.pedIncidentsTotal,
    crashesHappened: m.crashes.happened,
    crashesOpen: m.crashes.open,
    gridlockPenalties: m.gridlockPenaltyTotal,
    combos: m.combos,
    medals,
  };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
