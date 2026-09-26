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
        <span className="hover-wiggle flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-white shadow-sm">
          <IconRoad className="h-4 w-4" />
        </span>
        <span className="font-display hidden text-base font-extrabold tracking-tight text-[#241b3d] sm:inline">
          Road Constructor
        </span>
      </div>

      <div className="h-6 w-px bg-black/10" />

      <div className="flex items-center gap-1 rounded-full bg-black/5 p-1">
        <button
          type="button"
          onClick={() => setMode("build")}
          className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
            mode === "build"
              ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          Build
        </button>
        <button
          type="button"
          onClick={() => setMode("simulate")}
          className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
            mode === "simulate"
              ? "bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          Open to Traffic 🚦
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
                className={`rounded-full px-2.5 py-1.5 text-[11px] font-bold tabular-nums transition ${
                  speedMultiplier === mult
                    ? "bg-gradient-to-br from-sky-400 to-blue-500 text-white"
                    : "text-zinc-600 hover:text-zinc-900"
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
