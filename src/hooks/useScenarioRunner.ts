"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  finalizeScenario,
  CHALLENGE_PREFIX,
  DAILY_PREFIX,
  getScenarioById,
  SCENARIOS,
  type ScenarioDef,
  type ScenarioEvaluator,
  type ScenarioProgress,
  type ScenarioResult,
} from "@/sim/scenarios";
import { assembleNetworkCached } from "@/sim/network";
import { useEditorStore } from "@/state/editorStore";
import { bestStarsFor, recordStars } from "@/lib/progress";
import { recordRun } from "@/lib/career";
import { buildServiceReport } from "@/lib/serviceReport";
import { dateKey, recordDaily } from "@/lib/daily";
import { pushToast } from "@/lib/toast";
import { isRealCityLoaded, loadRealCity } from "@/sim/real";
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
  // Depend on the pieces, not on `sim` itself: the object is rebuilt on every render, which made the evaluation effect
  // re-run (and set state) after every render without end once a second level began.
  const metrics = sim.metrics;
  const setSimRunning = sim.setRunning;
  const getRecording = sim.getRecording;
  const getHighlights = sim.getHighlights;
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
    const baseline = metrics.simTime;
    evaluatorRef.current = scenario.createEvaluator();
    const raf = requestAnimationFrame(() => setStartSimTime(baseline));
    return () => cancelAnimationFrame(raf);
  }, [scenario, mode, results, startSimTime, metrics.simTime]);

  // A fresh run resets the sim clock to 0; if we captured a baseline from the previous run, follow it back down.
  useEffect(() => {
    if (startSimTime === null || metrics.simTime >= startSimTime) return;
    const raf = requestAnimationFrame(() => setStartSimTime(metrics.simTime));
    return () => cancelAnimationFrame(raf);
  }, [startSimTime, metrics.simTime]);

  // Evaluate the win condition every metrics tick; finalize on an early win or once time runs out.
  useEffect(() => {
    if (!scenario || mode !== "simulate" || results || startSimTime === null || !evaluatorRef.current) return;
    const elapsedS = metrics.simTime - startSimTime;
    const budgetRemaining = useEditorStore.getState().budget;
    const evalProgress = evaluatorRef.current({
      simTimeS: metrics.simTime,
      elapsedS,
      avgSpeedMph: metrics.avgSpeedMph,
      activeCount: metrics.activeCount,
      spawnedTotal: metrics.spawnedTotal,
      completedTripsTotal: metrics.completedTripsTotal,
      peopleMovedTotal: metrics.peopleMovedTotal,
      tripDelayTotalS: metrics.tripDelayTotalS,
      tripFreeFlowTotalS: metrics.tripFreeFlowTotalS,
      tripsTimed: metrics.tripsTimed,
      queuePeakFt: metrics.queuePeakFt,
      pedServedTotal: metrics.pedServedTotal,
      pedIncidentsTotal: metrics.pedIncidentsTotal,
      emergency: metrics.emergency,
      crashes: metrics.crashes,
      gridlockPenaltyTotal: metrics.gridlockPenaltyTotal,
      edgeTrafficStats: metrics.edgeTrafficStats,
      gridlockMarkers: metrics.gridlockMarkers,
      budgetRemaining,
      network,
    });
    setProgress(evalProgress);

    if (evalProgress.won || elapsedS >= scenario.durationS) {
      const result = finalizeScenario(
        scenario,
        evalProgress.won,
        { avgSpeedMph: metrics.avgSpeedMph, budgetRemaining, starsOverride: evalProgress.stars },
        evalProgress.detailLines
      );
      const report = buildServiceReport(metrics, scenario.serviceBaseline);
      const recording = getRecording();
      const highlights = getHighlights();
      const raf = requestAnimationFrame(() => {
        const previousStars = bestStarsFor(scenario.id);
        // Stars (and funds for them) belong to the campaign levels; a daily or a friend's challenge pays only for medals and the replay.
        const rated = !scenario.id.startsWith(DAILY_PREFIX) && !scenario.id.startsWith(CHALLENGE_PREFIX);
        const payout = result.won
          ? recordRun(scenario.id, { stars: rated ? result.stars : 0, previousStars: rated ? previousStars : 0, earned: report.medals.filter((m) => m.earned).map((m) => m.id) })
          : undefined;
        if (scenario.id.startsWith(DAILY_PREFIX)) {
          // Dailies keep a best-of-the-day score and a streak instead of a permanent star rating.
          const moved = metrics.completedTripsTotal;
          if (result.won && recordDaily(dateKey(), moved)) pushToast(`📅 New best for today: ${moved} vehicles moved`, "good");
        } else if (result.won && recordStars(scenario.id, result.stars)) {
          pushToast(`⭐ ${"★".repeat(result.stars)} saved for ${scenario.name}`, "good");
        }
        setResults({ ...result, score: evalProgress.score ?? null, report, payout, recording, highlights });
        setSimRunning(false);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [scenario, mode, results, startSimTime, metrics, setSimRunning, getRecording, getHighlights, network]);

  const startScenario = useCallback(
    (def: ScenarioDef) => {
      const begin = () => {
        loadScenario(def);
        setStartSimTime(null);
        setResults(null);
        setProgress(null);
      };
      // A real city's roads are fetched the first time its level opens.
      if (def.real && def.sceneryKey && !isRealCityLoaded(def.sceneryKey)) {
        pushToast(`Loading ${def.name}…`, "info");
        loadRealCity(def.sceneryKey).then(begin, () => pushToast("Couldn't load that map. Check your connection and try again", "bad"));
        return;
      }
      begin();
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
    // The daily challenge isn't part of the campaign order, so there's no "next level" after it.
    if (idx < 0) {
      exitToFreeBuild();
      return;
    }
    const next = SCENARIOS[idx + 1];
    if (next) startScenario(next);
    else exitToFreeBuild();
  }, [scenario, startScenario, exitToFreeBuild]);

  const remainingS =
    scenario && startSimTime !== null
      ? Math.max(0, scenario.durationS - (metrics.simTime - startSimTime))
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
