"use client";

import { useEffect, useRef } from "react";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import { pushToast } from "@/lib/toast";
import { clearPanic, setPanic } from "@/lib/panic";

/** Seconds of warning before a scripted event, so the player has a moment to react. */
const WARN_LEAD_S = 10;

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

  // Leaving the level takes its banner with it.
  useEffect(() => () => clearPanic(), []);

  useEffect(() => {
    if (!events || !scenario) return;
    // A restart rewinds the clock: forget what was already announced.
    if (elapsed < lastElapsed.current - 1) {
      fired.current.clear();
      clearPanic();
    }
    lastElapsed.current = elapsed;

    events.forEach((e, i) => {
      const warnKey = `${scenario.id}:${i}:warn`;
      const goKey = `${scenario.id}:${i}:go`;
      const text =
        e.kind === "surge"
          ? `RUSH HOUR - DEMAND UP ${Math.round((e.multiplier - 1) * 100)}% FOR ${e.durationS}S`
          : e.kind === "ambulance"
            ? "AMBULANCE CALL - CLEAR ITS WAY"
            : e.kind === "crash" || e.kind === "fender"
              ? "CRASH REPORTED AHEAD - EXPECT A BLOCKED LANE"
              : e.kind === "stall"
                ? "18-WHEELER LOSING POWER - LANE ABOUT TO BLOCK"
                : e.kind === "debris"
                  ? "LOAD COMING OFF A TRUCK - DEBRIS ON THE ROAD"
                  : "CAR BREAKING DOWN AHEAD";
      if (elapsed >= e.atS - WARN_LEAD_S && elapsed < e.atS) {
        // The banner counts down on the level's own clock; the siren sounds when it first appears.
        setPanic({ id: warnKey, text, secondsLeft: e.atS - elapsed });
        fired.current.add(warnKey);
      } else if (elapsed >= e.atS) {
        clearPanic(warnKey);
      }
      if (elapsed >= e.atS && !fired.current.has(goKey)) {
        fired.current.add(goKey);
        if (e.kind === "surge") pushToast(`🚗💨 SURGE! Demand is up ${Math.round((e.multiplier - 1) * 100)}% for ${e.durationS}s`, "alert");
        else if (e.kind === "ambulance") pushToast("🚑 Ambulance dispatched! Clear its way", "alert");
        else if (e.kind === "crash") pushToast("💥 Crash! Two cars are blocking the road. Police are on their way", "alert");
        else if (e.kind === "stall" || e.kind === "debris" || e.kind === "fender") pushToast("🚧 Incident! Tap its pin to send a wrecker", "alert");
        else pushToast("🚨 Breakdown! A car has stalled in the road", "alert");
      }
    });
  }, [events, scenario, elapsed]);

  return null;
}
