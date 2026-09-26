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
  const shouldPulse = mode === "build";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={mode === "simulate" && !ready}
      title={mode === "build" ? "Open to traffic" : showPause ? "Pause" : "Play"}
      className={`pointer-events-auto absolute right-4 top-4 z-20 flex h-12 w-12 items-center justify-center rounded-2xl border-2 border-[#2b1c40] bg-gradient-to-br from-emerald-400 to-green-500 text-white shadow-[0_4px_0_#145c3d] transition hover:-translate-y-0.5 hover:shadow-[0_6px_0_#145c3d] active:translate-y-1 active:shadow-[0_1px_0_#145c3d] disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:shadow-[0_4px_0_#145c3d] ${
        shouldPulse ? "animate-idle-pulse" : ""
      }`}
    >
      {showPause ? <IconPause className="h-5 w-5" /> : <IconPlay className="ml-0.5 h-5 w-5" />}
    </button>
  );
}
