"use client";

import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { IconPause, IconPlay, IconRoad } from "./icons";

const SPEED_OPTIONS = [1, 2, 5, 10];

export default function TopBar({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const { running, speedMultiplier, ready, setRunning, setSpeedMultiplier } = sim;

  return (
    <div className="pointer-events-auto absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full p-1.5 hud-panel">
      <div className="flex items-center gap-1.5 pl-2 pr-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-500/15 text-sky-400">
          <IconRoad className="h-3.5 w-3.5" />
        </span>
        <span className="hidden text-sm font-semibold tracking-tight text-zinc-50 sm:inline">
          Road Constructor
        </span>
      </div>

      <div className="h-6 w-px bg-white/10" />

      <div className="flex items-center gap-1 rounded-full bg-black/25 p-1">
        <button
          type="button"
          onClick={() => setMode("build")}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
            mode === "build" ? "bg-white text-zinc-900 shadow" : "text-zinc-300 hover:text-white"
          }`}
        >
          Build
        </button>
        <button
          type="button"
          onClick={() => setMode("simulate")}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
            mode === "simulate" ? "bg-emerald-400 text-emerald-950 shadow" : "text-zinc-300 hover:text-white"
          }`}
        >
          Open to Traffic
        </button>
      </div>

      {mode === "simulate" && (
        <>
          <div className="h-6 w-px bg-white/10" />
          <button
            type="button"
            onClick={() => setRunning(!running)}
            disabled={!ready}
            title={running ? "Pause" : "Play"}
            className="icon-btn h-9 w-9 disabled:opacity-40"
          >
            {running ? <IconPause className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}
          </button>
          <div className="flex items-center gap-0.5 rounded-full bg-black/25 p-1">
            {SPEED_OPTIONS.map((mult) => (
              <button
                key={mult}
                type="button"
                onClick={() => setSpeedMultiplier(mult)}
                className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold tabular-nums transition ${
                  speedMultiplier === mult ? "bg-sky-400 text-sky-950" : "text-zinc-300 hover:text-white"
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
