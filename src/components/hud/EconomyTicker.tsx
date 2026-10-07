"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { STARTING_BUDGET, useEditorStore } from "@/state/editorStore";
import { getScenarioById } from "@/sim/scenarios";

/** Charges upkeep (and credits parking income) to the budget as the simulation clock advances. Renders nothing. */
/** Game dollars a car pays per second in an express lane, scaled to the level's own money (a $2M city over five minutes: about $3). */
const TOLL_FRACTION_OF_BUDGET_PER_RUN = 0.00045;

export default function EconomyTicker({ sim }: { sim: UseTrafficSimulationReturn }) {
  const last = useRef(0);
  const lastExpress = useRef(0);
  const { simTime, expressVehicleS } = sim.metrics;

  // Toll revenue: the cars that spent time in express lanes since the last tick pay for it.
  useEffect(() => {
    const d = expressVehicleS - lastExpress.current;
    lastExpress.current = expressVehicleS;
    const s = useEditorStore.getState();
    if (d < 0) {
      s.creditToll(0, true); // a new run: the total starts again
      return;
    }
    if (d === 0 || d > 400 || s.mode !== "simulate") return;
    const def = s.activeScenarioId ? getScenarioById(s.activeScenarioId) : undefined;
    const base = def ? def.startingBudget : STARTING_BUDGET;
    const duration = def ? def.durationS : 300;
    s.creditToll((d * TOLL_FRACTION_OF_BUDGET_PER_RUN * base) / duration);
  }, [expressVehicleS]);

  useEffect(() => {
    const dt = simTime - last.current;
    last.current = simTime;
    const s = useEditorStore.getState();
    // A restarted run rewinds the clock (dt < 0), and a long gap (tab asleep) isn't spend the player should pay for.
    if (!sim.running || s.mode !== "simulate" || dt <= 0 || dt > 4) return;
    s.applyEconomy(dt);
  }, [simTime, sim.running]);

  return null;
}
