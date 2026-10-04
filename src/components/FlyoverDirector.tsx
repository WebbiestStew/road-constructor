"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useFlyover, stopFlyover } from "@/lib/cinematic";
import { setPhotoMode, setTour, usePhotoMode } from "@/lib/photoMode";
import { useEditorStore } from "@/state/editorStore";

/** Traffic runs this many times faster during a flyover, so the light trails build up like a long exposure. */
const TIME_LAPSE = 4;
/** Real seconds of dusk before the flyover turns to night. */
const DUSK_S = 16;

/**
 * Runs the flyover: dusk turning to night, the tour camera, and traffic in time-lapse. Leaving photo mode (H or Esc, or
 * the overlay's Exit) ends it and puts the light, the speed and the pause back as they were. Renders nothing.
 */
export default function FlyoverDirector({ sim }: { sim: UseTrafficSimulationReturn }) {
  const flyover = useFlyover();
  const photo = usePhotoMode();
  const saved = useRef<{ timeOfDay: "day" | "dusk" | "night"; speed: number } | null>(null);
  const simRef = useRef(sim);
  useEffect(() => {
    simRef.current = sim;
  });
  const started = useRef(false);

  useEffect(() => {
    if (!flyover) return;
    const store = useEditorStore.getState();
    saved.current = { timeOfDay: store.timeOfDay, speed: simRef.current.speedMultiplier };
    started.current = false;
    store.setTimeOfDay("dusk");
    setTour(true);
    simRef.current.setSpeedMultiplier(TIME_LAPSE);
    simRef.current.setRunning(true);
    const toNight = window.setTimeout(() => useEditorStore.getState().setTimeOfDay("night"), DUSK_S * 1000);
    const armed = window.setTimeout(() => {
      started.current = true;
    }, 400);
    return () => {
      window.clearTimeout(toNight);
      window.clearTimeout(armed);
      const prev = saved.current;
      if (prev) {
        useEditorStore.getState().setTimeOfDay(prev.timeOfDay);
        simRef.current.setSpeedMultiplier(prev.speed);
        simRef.current.setRunning(false);
      }
      saved.current = null;
      setPhotoMode(false);
    };
  }, [flyover]);

  // Leaving photo mode by any route ends the flyover.
  useEffect(() => {
    if (flyover && !photo && started.current) stopFlyover();
  }, [flyover, photo]);

  return null;
}
