"use client";

import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { IconPlay } from "./icons";

/**
 * The big floating "open to traffic" call-to-action while in Build mode.
 * Once Simulate mode is entered, the TopBar grows its own Play/Pause +
 * speed + Reset Traffic control bar, so this button steps aside entirely
 * rather than duplicating those controls.
 */
export default function PlayButton({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const { ready } = sim;

  if (mode === "simulate") return null;

  return (
    <button
      type="button"
      onClick={() => setMode("simulate")}
      disabled={!ready}
      title="Open to traffic"
      className="pointer-events-auto absolute right-4 top-4 z-20 flex h-12 w-12 items-center justify-center rounded-2xl border-2 border-[#2b1c40] bg-gradient-to-br from-emerald-400 to-green-500 text-white shadow-[0_4px_0_#145c3d] transition hover:-translate-y-0.5 hover:shadow-[0_6px_0_#145c3d] active:translate-y-1 active:shadow-[0_1px_0_#145c3d] disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:shadow-[0_4px_0_#145c3d] animate-idle-pulse"
    >
      <IconPlay className="ml-0.5 h-5 w-5" />
    </button>
  );
}
