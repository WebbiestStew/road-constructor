"use client";

import { useEditorStore } from "@/state/editorStore";

/** A faint always-on edge tint (violet = Build, emerald = Simulate) so the current mode reads at a glance even from a screenshot or a quick look away from the small top-bar toggle. Purely decorative — no pointer events. */
export default function ModeVignette() {
  const mode = useEditorStore((s) => s.mode);

  return (
    <div
      className={`mode-vignette ${mode === "build" ? "mode-vignette-build" : "mode-vignette-simulate"}`}
    />
  );
}
