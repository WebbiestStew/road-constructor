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

  const text = mode === "build" ? HINTS[tool] : "🚗 Watch it flow, or hit Pause to freeze and stare at the chaos.";

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
      <div className="hud-panel flex items-center gap-2 rounded-full px-4 py-2 text-[11px] text-zinc-700">
        <span>{text}</span>
        <span className="text-zinc-400">&middot;</span>
        <span className="whitespace-nowrap text-zinc-500">right-drag orbit &middot; middle-drag pan &middot; scroll zoom</span>
      </div>
    </div>
  );
}
