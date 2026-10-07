"use client";

import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";

/** What rain, fog or the dark are doing to traffic right now, in the plain terms a player can act on. Hidden on a clear day. */
export default function ConditionsChip({ sim }: { sim: UseTrafficSimulationReturn }) {
  const weather = sim.metrics.weather;
  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  const effects: string[] = [];
  let icon = "";
  let title = "";
  if (weather === "rain") {
    icon = "🌧️";
    title = "Rain";
    effects.push("20% slower", "30% bigger gaps", "wet roads: gentler braking, slower curves");
  } else if (weather === "fog") {
    icon = "🌫️";
    title = "Fog";
    effects.push("15% slower", "20% bigger gaps", "people seen late at crossings");
  }
  if (timeOfDay === "night" || timeOfDay === "dusk") {
    const dark = timeOfDay === "night";
    if (!icon) {
      icon = dark ? "🌙" : "🌆";
      title = dark ? "Night" : "Dusk";
    } else {
      title += dark ? " at night" : " at dusk";
    }
    effects.push(dark ? "unlit lanes 14% slower" : "unlit lanes 7% slower", "people seen late at crossings");
  }
  if (effects.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-[7.5rem] z-20 hidden -translate-x-1/2 md:block">
      <div className="hud-panel flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] font-bold text-[#241b3d]">
        <span className="text-base leading-none">{icon}</span>
        <span>{title}</span>
        <span className="font-semibold text-zinc-500">{Array.from(new Set(effects)).join(" · ")}</span>
      </div>
    </div>
  );
}
