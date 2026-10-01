"use client";

import { useEffect, useRef, useState } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { computeMood, mayorLine, moodFace } from "@/lib/mood";

/** The mayor changes the subject at most this often (real seconds), so the line is readable. */
const LINE_ROTATE_MS = 14000;

/** A slim mood meter for the city's drivers plus a one-line comment from the mayor. */
export default function CityMood({ sim }: { sim: UseTrafficSimulationReturn }) {
  const m = sim.metrics;
  const mood = computeMood({
    edgeTrafficStats: m.edgeTrafficStats,
    problemEdgeCount: m.problemEdgeIds.length,
    gridlockPenaltyTotal: m.gridlockPenaltyTotal,
    activeCount: m.activeCount,
  });

  const [salt, setSalt] = useState(0);
  const lastRotate = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (performance.now() - lastRotate.current >= LINE_ROTATE_MS) {
        lastRotate.current = performance.now();
        setSalt((s) => s + 1);
      }
    }, 2000);
    return () => clearInterval(id);
  }, []);

  const color = mood >= 70 ? "from-emerald-400 to-teal-500" : mood >= 40 ? "from-amber-400 to-orange-500" : "from-rose-400 to-red-500";

  return (
    <div className="hud-panel flex flex-col gap-2 rounded-2xl px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="text-2xl leading-none" aria-hidden>
          {moodFace(mood)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-zinc-500">City mood</span>
            <span className="font-display text-sm font-extrabold tabular-nums text-[#241b3d]">{mood}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-black/10">
            <div className={`h-full rounded-full bg-gradient-to-r transition-all duration-700 ${color}`} style={{ width: `${mood}%` }} />
          </div>
        </div>
      </div>
      <p className="text-[11px] font-semibold italic leading-snug text-zinc-600">
        🎙️ Mayor: &ldquo;{mayorLine(mood, m.problemEdgeIds.length, salt)}&rdquo;
      </p>
    </div>
  );
}
