"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { pushToast } from "@/lib/toast";

/**
 * Speaks for the emergency responders: calls out each dispatch, and when an ambulance arrives says how long it took
 * against how long an empty road would have, which is the player's report card for keeping routes clear.
 * Renders nothing.
 */
export default function EmergencyAnnouncer({ sim }: { sim: UseTrafficSimulationReturn }) {
  const { emergency, crashes } = sim.metrics;
  const seen = useRef({ dispatched: 0, completed: 0 });
  const seenCrash = useRef({ happened: 0, cleared: 0 });

  useEffect(() => {
    const s = seen.current;
    // A fresh run starts the counters from zero again.
    if (emergency.dispatched < s.dispatched || emergency.completed < s.completed) {
      s.dispatched = 0;
      s.completed = 0;
    }
    if (emergency.dispatched > s.dispatched) {
      s.dispatched = emergency.dispatched;
      pushToast("🚑 Ambulance on the way. Keep its route moving", "alert");
    }
    if (emergency.completed > s.completed) {
      s.completed = emergency.completed;
      const took = Math.round(emergency.lastResponseS);
      const ideal = Math.max(1, Math.round(emergency.lastIdealS));
      const ratio = emergency.lastResponseS / Math.max(1, emergency.lastIdealS);
      if (ratio <= 1.5) pushToast(`🚑 Ambulance arrived in ${took}s (${ideal}s on an empty road). Right on time`, "good");
      else if (ratio <= 2.4) pushToast(`🚑 Ambulance took ${took}s, against ${ideal}s on an empty road. A bit slow`, "alert");
      else pushToast(`🚑 Ambulance took ${took}s, against ${ideal}s on an empty road. Too slow`, "bad");
    }
  }, [emergency]);

  useEffect(() => {
    const s = seenCrash.current;
    if (crashes.happened < s.happened || crashes.cleared < s.cleared) {
      s.happened = 0;
      s.cleared = 0;
    }
    // Crashes that arrive from a level's script are announced by its own announcer; these are the player-started ones.
    if (crashes.happened > s.happened) s.happened = crashes.happened;
    if (crashes.cleared > s.cleared) {
      s.cleared = crashes.cleared;
      const took = Math.round(crashes.lastClearS);
      if (took <= 75) pushToast(`🚓 Crash cleared in ${took}s. The road is open again`, "good");
      else if (took <= 100) pushToast(`🚓 Crash cleared in ${took}s. A little slow`, "alert");
      else pushToast(`🚓 Crash took ${took}s to clear. Traffic made it hard for the police to reach it`, "bad");
    }
  }, [crashes]);

  return null;
}
