"use client";

import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { IconPause, IconPlay } from "./icons";

export default function PlayButton({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const { running, ready, setRunning } = sim;

  const handleClick = () => {
    if (mode === "build") {
      setMode("simulate");
    } else {
      setRunning(!running);
    }
  };

  const showPause = mode === "simulate" && running;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={mode === "simulate" && !ready}
      title={mode === "build" ? "Open to traffic" : showPause ? "Pause" : "Play"}
      className="pointer-events-auto absolute right-4 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-400 active:scale-95 disabled:opacity-40"
    >
      {showPause ? <IconPause className="h-5 w-5" /> : <IconPlay className="ml-0.5 h-5 w-5" />}
    </button>
  );
}
