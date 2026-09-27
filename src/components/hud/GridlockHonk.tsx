"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { playGridlockHonk } from "@/lib/sound";

/** Minimum real seconds between honks, so a whole network stuck at LOS F doesn't spam the speaker. */
const HONK_COOLDOWN_MS = 4000;

/** Sounds a horn honk whenever a road segment first breaks down to Level of Service F. No visual output. */
export default function GridlockHonk({ sim }: { sim: UseTrafficSimulationReturn }) {
  const gradeFEdgesRef = useRef<Set<string>>(new Set());
  const lastHonkRef = useRef(0);

  useEffect(() => {
    let newlyBroken = false;
    const stillF = new Set<string>();
    for (const s of sim.metrics.edgeTrafficStats) {
      if (s.los !== "F") continue;
      stillF.add(s.edgeId);
      if (!gradeFEdgesRef.current.has(s.edgeId)) newlyBroken = true;
    }
    gradeFEdgesRef.current = stillF;

    if (!newlyBroken) return;
    const now = performance.now();
    if (now - lastHonkRef.current < HONK_COOLDOWN_MS) return;
    lastHonkRef.current = now;
    playGridlockHonk();
  }, [sim.metrics.edgeTrafficStats]);

  return null;
}
