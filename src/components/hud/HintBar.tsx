"use client";

import { useEditorStore, type EditorTool } from "@/state/editorStore";

const HINTS: Record<EditorTool, string> = {
  draw: "Click to start a road, click again to extend it. Click an existing road to tap in a junction.",
  delete: "Click a road or junction to demolish it (50% refund).",
  inspect: "Click a road or junction to edit its lanes, direction, class, or junction control.",
  zone: "Click a road to cycle it: none → Entry → Destination → none.",
};

export default function HintBar() {
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);

  const text = mode === "build" ? HINTS[tool] : "Watch it flow, or hit Pause to freeze and inspect a jam.";

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
      <div className="hud-panel flex items-center gap-2 rounded-full px-4 py-2 text-[11px] text-zinc-300">
        <span>{text}</span>
        <span className="text-zinc-600">&middot;</span>
        <span className="whitespace-nowrap text-zinc-500">right-drag orbit &middot; middle-drag pan &middot; scroll zoom</span>
      </div>
    </div>
  );
}
