"use client";

import type { ComponentType, SVGProps } from "react";
import { ELEVATION_LEVELS, ROAD_CLASS_LIST } from "@/sim/roadClasses";
import { useEditorStore, type EditorTool } from "@/state/editorStore";
import { IconDelete, IconDraw, IconInspect, IconZone } from "./icons";

const TOOLS: { id: EditorTool; icon: ComponentType<SVGProps<SVGSVGElement>>; label: string }[] = [
  { id: "draw", icon: IconDraw, label: "Draw" },
  { id: "delete", icon: IconDelete, label: "Delete" },
  { id: "inspect", icon: IconInspect, label: "Inspect" },
  { id: "zone", icon: IconZone, label: "Zone" },
];

function DockButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        data-active={active}
        aria-label={label}
        className="icon-btn h-11 w-11"
      >
        <Icon className="h-5 w-5" />
      </button>
      <span className="pointer-events-none absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-100 opacity-0 shadow-lg ring-1 ring-white/10 transition group-hover:opacity-100">
        {label}
      </span>
    </div>
  );
}

function LaneBars({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className="h-2.5 w-1 rounded-sm bg-current" />
      ))}
    </div>
  );
}

function DrawFlyout() {
  const selectedRoadClassId = useEditorStore((s) => s.selectedRoadClassId);
  const setRoadClass = useEditorStore((s) => s.setRoadClass);
  const selectedElevationId = useEditorStore((s) => s.selectedElevationId);
  const setElevation = useEditorStore((s) => s.setElevation);
  const twoWay = useEditorStore((s) => s.twoWay);
  const setTwoWay = useEditorStore((s) => s.setTwoWay);
  const drawFromNodeId = useEditorStore((s) => s.drawFromNodeId);
  const cancelDrawChain = useEditorStore((s) => s.cancelDrawChain);

  return (
    <div className="hud-panel absolute left-full top-0 ml-3 w-64 rounded-2xl p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Road class</span>
        <span className="text-[10px] text-zinc-600">keys 1-5</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {ROAD_CLASS_LIST.map((cls, i) => (
          <button
            key={cls.id}
            type="button"
            onClick={() => setRoadClass(cls.id)}
            className={`flex items-center justify-between rounded-xl px-3 py-2 text-left transition ${
              selectedRoadClassId === cls.id
                ? "bg-sky-500 text-white"
                : "bg-white/5 text-zinc-200 hover:bg-white/10"
            }`}
          >
            <span className="flex items-center gap-2">
              <span className="flex h-5 w-4 items-center justify-center rounded bg-black/20 text-[10px] font-bold">
                {i + 1}
              </span>
              <span className="text-xs font-medium">{cls.label}</span>
            </span>
            <span className="flex items-center gap-2 text-[10px] opacity-80">
              <LaneBars count={cls.lanesPerDirection} />
              {cls.speedLimitMph}mph
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Elevation</div>
      <div className="mt-1.5 grid grid-cols-5 gap-1">
        {ELEVATION_LEVELS.map((lvl) => (
          <button
            key={lvl.id}
            type="button"
            onClick={() => setElevation(lvl.id)}
            title={`${lvl.label} (${lvl.elevationFt >= 0 ? "+" : ""}${lvl.elevationFt} ft)`}
            className={`flex flex-col items-center gap-1.5 rounded-lg py-2 text-[8.5px] font-medium leading-none transition ${
              selectedElevationId === lvl.id
                ? "bg-sky-500 text-white"
                : "bg-white/5 text-zinc-300 hover:bg-white/10"
            }`}
          >
            <span
              className="w-1.5 rounded-full bg-current"
              style={{ height: 4 + ((lvl.elevationFt + 35) / 77) * 16 }}
            />
            {lvl.label}
          </button>
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={twoWay}
          onChange={(e) => setTwoWay(e.target.checked)}
          className="accent-sky-500"
        />
        Two-way road
      </label>

      {drawFromNodeId && (
        <button
          type="button"
          onClick={cancelDrawChain}
          className="mt-3 w-full rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-zinc-100 hover:bg-white/20"
        >
          Finish road (Esc)
        </button>
      )}
    </div>
  );
}

export default function ToolDock() {
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);

  if (mode !== "build") return null;

  return (
    <div className="pointer-events-auto absolute left-4 top-1/2 z-20 -translate-y-1/2">
      <div className="hud-panel relative flex flex-col gap-1.5 rounded-2xl p-1.5">
        {TOOLS.map((t) => (
          <DockButton key={t.id} active={tool === t.id} icon={t.icon} label={t.label} onClick={() => setTool(t.id)} />
        ))}
        {tool === "draw" && <DrawFlyout />}
      </div>
    </div>
  );
}
