"use client";

import { useEditorStore, type EditorTool } from "@/state/editorStore";

const HINTS: Record<EditorTool, string> = {
  draw: "🖊️ Click to start a road, click again to keep going. Click an existing road to tap in a junction.",
  delete: "💣 Click a road or junction to blow it up (50% refund, no hard feelings).",
  inspect: "🔍 Click a road or junction to fiddle with its lanes, direction, class, or signals.",
  zone: "🚩 Click a road to cycle it: none → Entry → Destination → none.",
  turnaround: "🔁 Click a frontage road — we'll loop a one-way Texas turnaround to the nearest opposing road within 220 ft.",
};

export default function HintBar() {
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);

  const text =
    mode === "build"
      ? HINTS[tool]
      : "🚗 Watch it flow, or click a road or junction for live LOS/speed stats. Space to pause.";

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
      <div className="hud-panel flex max-w-64 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-2xl px-4 py-2 text-center text-[11px] text-zinc-700 sm:max-w-none sm:rounded-full">
        <span>{text}</span>
        <span className="hidden text-zinc-400 sm:inline">&middot;</span>
        <span className="hidden whitespace-nowrap text-zinc-500 sm:inline">right-drag orbit &middot; middle-drag pan &middot; scroll zoom</span>
      </div>
    </div>
  );
}
