"use client";

import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { IconRoad } from "./icons";

const SPEED_OPTIONS = [1, 2, 5, 10];

export default function TopBar({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const { speedMultiplier, setSpeedMultiplier } = sim;

  return (
    <div className="pointer-events-auto absolute left-4 top-4 z-20 flex items-center gap-1 rounded-full p-1.5 hud-panel">
      <div className="flex items-center gap-1.5 pl-1.5 pr-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/15 text-amber-700">
          <IconRoad className="h-3.5 w-3.5" />
        </span>
        <span className="hidden text-sm font-semibold tracking-tight text-zinc-900 sm:inline">
          Road Constructor
        </span>
      </div>

      <div className="h-6 w-px bg-black/10" />

      <div className="flex items-center gap-1 rounded-full bg-black/5 p-1">
        <button
          type="button"
          onClick={() => setMode("build")}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
            mode === "build" ? "bg-zinc-900 text-white shadow" : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          Build
        </button>
        <button
          type="button"
          onClick={() => setMode("simulate")}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
            mode === "simulate" ? "bg-emerald-500 text-white shadow" : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          Open to Traffic
        </button>
      </div>

      {mode === "simulate" && (
        <>
          <div className="h-6 w-px bg-black/10" />
          <div className="flex items-center gap-0.5 rounded-full bg-black/5 p-1">
            {SPEED_OPTIONS.map((mult) => (
              <button
                key={mult}
                type="button"
                onClick={() => setSpeedMultiplier(mult)}
                className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold tabular-nums transition ${
                  speedMultiplier === mult ? "bg-sky-500 text-white" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {mult}×
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
