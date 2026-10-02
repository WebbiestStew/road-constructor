"use client";

import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { IconPause } from "./icons";

/** A hard-to-miss "Paused" banner while Simulate mode's clock is stopped — the play/pause icon swap in the top bar alone is easy to miss when glancing at a busy screen mid-build-review. */
export default function PausedBanner({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);

  if (mode !== "simulate" || sim.running) return null;

  return (
    <div className="pointer-events-none absolute left-1/2 top-44 z-20 -translate-x-1/2 max-md:top-[7.5rem] lg:top-24">
      <div className="animate-pop flex items-center gap-1.5 rounded-full border-2 border-[#2b1c40] bg-gradient-to-br from-amber-300 to-orange-400 px-3.5 py-1.5 text-xs font-bold text-white shadow-[0_3px_0_#7c2d12]">
        <IconPause className="h-3.5 w-3.5" />
        Paused — traffic is frozen
      </div>
    </div>
  );
}
