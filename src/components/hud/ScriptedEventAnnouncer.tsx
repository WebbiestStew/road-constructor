"use client";

import { useEffect, useRef } from "react";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import { pushToast } from "@/lib/toast";

/** Seconds of warning before a scripted event, so the player has a moment to react. */
const WARN_LEAD_S = 8;

/**
 * Calls out a level's scripted trouble as it approaches and arrives: "heads up" a few seconds ahead, then the event
 * itself. Driven by the level's own clock, so it lines up with the sim whatever the playback speed. Renders nothing.
 */
export default function ScriptedEventAnnouncer({ runner }: { runner: UseScenarioRunnerReturn }) {
  const { scenario, remainingS } = runner;
  const fired = useRef(new Set<string>());
  const lastElapsed = useRef(0);

  const events = scenario?.scriptedEvents;
  const elapsed = scenario ? scenario.durationS - remainingS : 0;

  useEffect(() => {
    if (!events || !scenario) return;
    // A restart rewinds the clock: forget what was already announced.
    if (elapsed < lastElapsed.current - 1) fired.current.clear();
    lastElapsed.current = elapsed;

    events.forEach((e, i) => {
      const warnKey = `${scenario.id}:${i}:warn`;
      const goKey = `${scenario.id}:${i}:go`;
      const what = e.kind === "surge" ? "a traffic surge" : e.kind === "ambulance" ? "an ambulance call" : "a breakdown";
      if (elapsed >= e.atS - WARN_LEAD_S && elapsed < e.atS && !fired.current.has(warnKey)) {
        fired.current.add(warnKey);
        pushToast(`⚠️ Heads up: ${what} in ${WARN_LEAD_S} seconds`, "alert");
      }
      if (elapsed >= e.atS && !fired.current.has(goKey)) {
        fired.current.add(goKey);
        if (e.kind === "surge") pushToast(`🚗💨 SURGE! Demand is up ${Math.round((e.multiplier - 1) * 100)}% for ${e.durationS}s`, "alert");
        else if (e.kind === "ambulance") pushToast("🚑 Ambulance dispatched! Clear its way", "alert");
        else pushToast("🚨 Breakdown! A car has stalled in the road", "alert");
      }
    });
  }, [events, scenario, elapsed]);

  return null;
}
