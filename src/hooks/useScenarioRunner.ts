"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  finalizeScenario,
  getScenarioById,
  SCENARIOS,
  type ScenarioDef,
  type ScenarioEvaluator,
  type ScenarioProgress,
  type ScenarioResult,
} from "@/sim/scenarios";
import { assembleNetworkCached } from "@/sim/network";
import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "./useTrafficSimulation";

/**
 * Owns the run lifecycle for campaign scenarios: starts the clock the moment
 * a scenario is opened to traffic, evaluates its win condition continuously
 * (a scenario can be won the instant its condition is met, not just at a
 * fixed end time), and finalizes a result — win or loss — either on that
 * early win or once the scenario's duration runs out. Pure free-build play
 * (no active scenario) is a no-op.
 */
export function useScenarioRunner(sim: UseTrafficSimulationReturn) {
  const activeScenarioId = useEditorStore((s) => s.activeScenarioId);
  const mode = useEditorStore((s) => s.mode);
  const loadScenario = useEditorStore((s) => s.loadScenario);
  const exitScenario = useEditorStore((s) => s.exitScenario);
  const enterSandboxMode = useEditorStore((s) => s.enterSandboxMode);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);

  const scenario = activeScenarioId ? getScenarioById(activeScenarioId) : undefined;
  const network = useMemo(() => assembleNetworkCached(nodes, edges), [nodes, edges]);

  const [results, setResults] = useState<ScenarioResult | null>(null);
  const [progress, setProgress] = useState<ScenarioProgress | null>(null);
  const [startSimTime, setStartSimTime] = useState<number | null>(null);
  const evaluatorRef = useRef<ScenarioEvaluator | null>(null);

  // Leaving Build resets the clock so the next "Open to Traffic" starts a fresh run.
  useEffect(() => {
    if (mode !== "build" || startSimTime === null) return;
    const raf = requestAnimationFrame(() => {
      setStartSimTime(null);
      setProgress(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [mode, startSimTime]);

  // Capture the worker's current simTime as this run's baseline the moment traffic opens, and spin up a fresh evaluator.
  useEffect(() => {
    if (!scenario || mode !== "simulate" || results || startSimTime !== null) return;
    const baseline = sim.metrics.simTime;
    evaluatorRef.current = scenario.createEvaluator();
    const raf = requestAnimationFrame(() => setStartSimTime(baseline));
    return () => cancelAnimationFrame(raf);
  }, [scenario, mode, results, startSimTime, sim.metrics.simTime]);

  // A fresh run resets the sim clock to 0; if we captured a baseline from the previous run, follow it back down.
  useEffect(() => {
    if (startSimTime === null || sim.metrics.simTime >= startSimTime) return;
    const raf = requestAnimationFrame(() => setStartSimTime(sim.metrics.simTime));
    return () => cancelAnimationFrame(raf);
  }, [startSimTime, sim.metrics.simTime]);

  // Evaluate the win condition every metrics tick; finalize on an early win or once time runs out.
  useEffect(() => {
    if (!scenario || mode !== "simulate" || results || startSimTime === null || !evaluatorRef.current) return;
    const elapsedS = sim.metrics.simTime - startSimTime;
    const budgetRemaining = useEditorStore.getState().budget;
    const evalProgress = evaluatorRef.current({
      simTimeS: sim.metrics.simTime,
      elapsedS,
      avgSpeedMph: sim.metrics.avgSpeedMph,
      activeCount: sim.metrics.activeCount,
      spawnedTotal: sim.metrics.spawnedTotal,
      completedTripsTotal: sim.metrics.completedTripsTotal,
      gridlockPenaltyTotal: sim.metrics.gridlockPenaltyTotal,
      edgeTrafficStats: sim.metrics.edgeTrafficStats,
      gridlockMarkers: sim.metrics.gridlockMarkers,
      budgetRemaining,
      network,
    });
    setProgress(evalProgress);

    if (evalProgress.won || elapsedS >= scenario.durationS) {
      const result = finalizeScenario(
        scenario,
        evalProgress.won,
        { avgSpeedMph: sim.metrics.avgSpeedMph, budgetRemaining },
        evalProgress.detailLines
      );
      const raf = requestAnimationFrame(() => {
        setResults(result);
        sim.setRunning(false);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [scenario, mode, results, startSimTime, sim, sim.metrics, network]);

  const startScenario = useCallback(
    (def: ScenarioDef) => {
      loadScenario(def);
      setStartSimTime(null);
      setResults(null);
      setProgress(null);
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
    setProgress(null);
  }, [exitScenario]);

  const continueSandbox = useCallback(() => {
    enterSandboxMode();
    setResults(null);
    setProgress(null);
  }, [enterSandboxMode]);

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
      : (scenario?.durationS ?? 0);

  return {
    scenario,
    results,
    progress,
    remainingS,
    isRunning: !!scenario && mode === "simulate" && !results,
    startScenario,
    retry,
    nextScenario,
    exitToFreeBuild,
    continueSandbox,
  };
}

export type UseScenarioRunnerReturn = ReturnType<typeof useScenarioRunner>;
