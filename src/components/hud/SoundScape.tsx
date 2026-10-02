"use client";

import { useEffect } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { setRainSound, setSirenSound } from "@/lib/sound";

/** Plays the weather and siren layers from what the sim reports. Renders nothing; silent while paused or muted. */
export default function SoundScape({ sim }: { sim: UseTrafficSimulationReturn }) {
  const rain = sim.metrics.weather === "rain" && sim.running;
  const siren = sim.metrics.emergency.active > 0 && sim.running;
  useEffect(() => {
    setRainSound(rain);
  }, [rain]);
  useEffect(() => {
    setSirenSound(siren);
  }, [siren]);
  // Leaving the game page must not leave a siren wailing.
  useEffect(() => () => {
    setRainSound(false);
    setSirenSound(false);
  }, []);
  return null;
}
