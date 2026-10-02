import { estimateEdgeUpkeepPerHour } from "./roadClasses";
import type { EdgeSpec, NodeSpec } from "./types";

/**
 * The running costs of a city while traffic is open: every road costs money to maintain, and street parking brings
 * some back. Rates are in game dollars per sim-second, scaled by a per-level factor `k` chosen so that keeping the
 * starting roads costs about 3% of the level's budget over one run. Building more costs more to keep up; parking
 * claws it back, at the price of slower traffic.
 */

/** The free-build default: a one-mile, four-lane highway costs about 3% of the $2M budget per five-minute run. */
export const FREE_BUILD_ECONOMY_K = 1.2;
const RUN_UPKEEP_FRACTION = 0.03;
/** Parking income per foot, per sim-second at k = 1: a little more than a street's own upkeep, so a parked street pays for itself. */
const PARKING_INCOME_PER_FT = 0.007;

function lengthFt(a: NodeSpec, b: NodeSpec): number {
  return Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]) * 1.03;
}

export interface EconomyRates {
  /** Dollars per sim-second spent on upkeep. */
  upkeep: number;
  /** Dollars per sim-second earned from parking. */
  income: number;
}

/** Raw (unscaled) hourly upkeep of a network. */
export function upkeepPerHour(nodes: NodeSpec[], edges: EdgeSpec[]): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let total = 0;
  for (const e of edges) {
    const a = byId.get(e.fromNodeId);
    const b = byId.get(e.toNodeId);
    if (a && b) total += estimateEdgeUpkeepPerHour(e.roadClassId, lengthFt(a, b), e.lanes);
  }
  return total;
}

/** The scale that makes the level's starting roads cost about 3% of its budget over its run. */
export function economyKFor(nodes: NodeSpec[], edges: EdgeSpec[], startingBudget: number, durationS: number): number {
  return (RUN_UPKEEP_FRACTION * startingBudget) / (durationS * Math.max(50, upkeepPerHour(nodes, edges)));
}

export function economyRates(nodes: NodeSpec[], edges: EdgeSpec[], k: number): EconomyRates {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let income = 0;
  for (const e of edges) {
    if (!e.parking) continue;
    const a = byId.get(e.fromNodeId);
    const b = byId.get(e.toNodeId);
    if (a && b) income += lengthFt(a, b) * PARKING_INCOME_PER_FT;
  }
  return { upkeep: upkeepPerHour(nodes, edges) * k, income: income * k };
}
