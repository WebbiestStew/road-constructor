"use client";

import { useCallback, useEffect, useState } from "react";
import { getScenarioById, scoreScenario, SCENARIOS, type ScenarioDef, type ScenarioResult } from "@/sim/scenarios";
import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "./useTrafficSimulation";

/**
 * Owns the timed-run lifecycle for campaign scenarios: starts the clock the
 * moment a scenario is opened to traffic, auto-pauses and scores once its
 * duration elapses, and exposes retry/next/free-build actions for the
 * results screen. Pure free-build play (no active scenario) is a no-op.
 */
export function useScenarioRunner(sim: UseTrafficSimulationReturn) {
  const activeScenarioId = useEditorStore((s) => s.activeScenarioId);
  const mode = useEditorStore((s) => s.mode);
  const loadScenario = useEditorStore((s) => s.loadScenario);
  const exitScenario = useEditorStore((s) => s.exitScenario);

  const scenario = activeScenarioId ? getScenarioById(activeScenarioId) : undefined;

  const [results, setResults] = useState<ScenarioResult | null>(null);
  const [startSimTime, setStartSimTime] = useState<number | null>(null);

  // Leaving Build resets the clock so the next "Open to Traffic" starts a fresh run.
  useEffect(() => {
    if (mode !== "build" || startSimTime === null) return;
    const raf = requestAnimationFrame(() => setStartSimTime(null));
    return () => cancelAnimationFrame(raf);
  }, [mode, startSimTime]);

  // Capture the worker's current simTime as this run's baseline the moment traffic opens.
  useEffect(() => {
    if (!scenario || mode !== "simulate" || results || startSimTime !== null) return;
    const baseline = sim.metrics.simTime;
    const raf = requestAnimationFrame(() => setStartSimTime(baseline));
    return () => cancelAnimationFrame(raf);
  }, [scenario, mode, results, startSimTime, sim.metrics.simTime]);

  // Score and auto-pause once the scenario's duration has elapsed.
  useEffect(() => {
    if (!scenario || mode !== "simulate" || results || startSimTime === null) return;
    const elapsed = sim.metrics.simTime - startSimTime;
    if (elapsed < scenario.durationS) return;
    const budgetRemaining = useEditorStore.getState().budget;
    const result = scoreScenario(scenario, sim.metrics, budgetRemaining);
    const raf = requestAnimationFrame(() => {
      setResults(result);
      sim.setRunning(false);
    });
    return () => cancelAnimationFrame(raf);
  }, [scenario, mode, results, startSimTime, sim, sim.metrics]);

  const startScenario = useCallback(
    (def: ScenarioDef) => {
      loadScenario(def);
      setStartSimTime(null);
      setResults(null);
    },
    [loadScenario]
  );

  const retry = useCallback(() => {
    if (!scenario) return;
    startScenario(scenario);
  }, [scenario, startScenario]);

  const exitToFreeBuild = useCallback(() => {
    exitScenario();
    setResults(null);
    setStartSimTime(null);
  }, [exitScenario]);

  const nextScenario = useCallback(() => {
    if (!scenario) return;
    const idx = SCENARIOS.findIndex((s) => s.id === scenario.id);
    const next = SCENARIOS[idx + 1];
    if (next) startScenario(next);
    else exitToFreeBuild();
  }, [scenario, startScenario, exitToFreeBuild]);

  const remainingS =
    scenario && startSimTime !== null
      ? Math.max(0, scenario.durationS - (sim.metrics.simTime - startSimTime))
      : scenario?.durationS ?? 0;

  return {
    scenario,
    results,
    remainingS,
    isRunning: !!scenario && mode === "simulate" && !results,
    startScenario,
    retry,
    nextScenario,
    exitToFreeBuild,
  };
}

export type UseScenarioRunnerReturn = ReturnType<typeof useScenarioRunner>;
