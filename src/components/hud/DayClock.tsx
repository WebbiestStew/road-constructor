"use client";

import { useEffect } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";

function formatClock(hour: number): string {
  const h24 = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function describeHour(hour: number): { emoji: string; label: string } {
  if (hour >= 7 && hour < 9.5) return { emoji: "🌅", label: "Morning rush" };
  if (hour >= 16 && hour < 19) return { emoji: "🌇", label: "Evening rush" };
  if (hour >= 20 || hour < 5) return { emoji: "🌙", label: "Quiet night" };
  if (hour >= 5 && hour < 7) return { emoji: "🌄", label: "Early morning" };
  return { emoji: "☀️", label: "Daytime" };
}

/** Which of the three lighting looks suits an hour of the day. */
function lightingFor(hour: number): "day" | "dusk" | "night" {
  if (hour >= 7.5 && hour < 17.5) return "day";
  if (hour >= 17.5 && hour < 20) return "dusk";
  if (hour >= 5 && hour < 7.5) return "dusk";
  return "night";
}

/** The clock for the 24-hour day cycle, and the lighting that follows it. Renders only while the cycle is on. */
export default function DayClock({ sim }: { sim: UseTrafficSimulationReturn }) {
  const hour = sim.metrics.clockHour;
  const setTimeOfDay = useEditorStore((s) => s.setTimeOfDay);
  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  const on = hour >= 0;
  const wanted = on ? lightingFor(hour) : null;

  useEffect(() => {
    if (wanted && wanted !== timeOfDay) setTimeOfDay(wanted);
  }, [wanted, timeOfDay, setTimeOfDay]);

  if (!on) return null;
  const { emoji, label } = describeHour(hour);
  return (
    <div className="pointer-events-none absolute left-1/2 top-[4.9rem] z-20 -translate-x-1/2 max-md:top-[7.1rem]">
      <div className="hud-panel flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-bold text-[#241b3d]">
        <span className="text-base leading-none">{emoji}</span>
        <span className="tabular-nums">{formatClock(hour)}</span>
        <span className="font-semibold text-zinc-500">{label}</span>
      </div>
    </div>
  );
}
