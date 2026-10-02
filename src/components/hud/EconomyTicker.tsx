"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";

/** Charges upkeep (and credits parking income) to the budget as the simulation clock advances. Renders nothing. */
export default function EconomyTicker({ sim }: { sim: UseTrafficSimulationReturn }) {
  const last = useRef(0);
  const { simTime } = sim.metrics;

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
