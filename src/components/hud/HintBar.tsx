"use client";

import { useEditorStore, type EditorTool } from "@/state/editorStore";

const HINTS: Record<EditorTool, string> = {
  draw: "🖊️ Click to start a road, click again to keep going. Click an existing road to tap in a junction.",
  delete: "💣 Click a road or junction to blow it up (50% refund, no hard feelings).",
  inspect: "🔍 Click a road or junction to fiddle with its lanes, direction, class, or signals.",
  zone: "🚩 Click a road to cycle it: none → Entry → Destination → none.",
  lanes: "↔️ Click a road that splits at a junction, then tap arrows to choose where each lane can go.",
  speed: "⚡ Click a road and pick a speed limit. Slow stretches back traffic up.",
  street: "🛣️ Click a road to reserve a lane for buses or bikes, make it one-way, or add a pedestrian crossing.",
  transit: "🚌 Click roads in order to draw a bus line. Buses run along it on a timetable and stop at bus stops.",
  gantry: "🛣️ Click a freeway gantry to post a speed advisory or close a lane ahead of an incident or a merge.",
  junction: "🚦 Click a junction to set priority or a traffic light, and tune its timing.",
  turnaround: "🔁 Click a frontage road — we'll loop a one-way Texas turnaround to the nearest opposing road within 220 ft.",
};

export default function HintBar() {
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);

  const text =
    mode === "build" || tool !== "inspect"
      ? HINTS[tool]
      : "🚗 Watch it flow, pick a traffic tool on the left to fix problems, or click a road for live LOS/speed stats. Space to pause.";

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 max-md:hidden">
      <div className="hud-panel flex max-w-64 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-2xl px-4 py-2 text-center text-[11px] text-zinc-700 sm:max-w-none sm:rounded-full">
        <span>{text}</span>
        <span className="hidden text-zinc-400 sm:inline">&middot;</span>
        <span className="hidden whitespace-nowrap text-zinc-500 sm:inline">WASD move &middot; N next road &middot; [ ] rotate &middot; right-drag orbit &middot; scroll zoom</span>
      </div>
    </div>
  );
}
