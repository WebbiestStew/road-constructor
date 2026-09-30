"use client";

import type { ComponentType, SVGProps } from "react";
import { ELEVATION_LEVELS, HOTKEY_TIER_IDS, ROAD_CLASS_LIST, TEXAS_TURNAROUND_SPEED_MPH } from "@/sim/roadClasses";
import { useEditorStore, type EditorTool } from "@/state/editorStore";
import { IconDelete, IconDraw, IconInspect, IconTurnaround, IconZone } from "./icons";

/** Primary Actions — the always-visible tool row. Draw/Zone/Inspect/Delete only; Turnaround lives with the other road-type picks below since it's really "what to draw," not a separate mode. */
const TOOLS: { id: EditorTool; icon: ComponentType<SVGProps<SVGSVGElement>>; label: string; hotkey: string }[] = [
  { id: "draw", icon: IconDraw, label: "Draw", hotkey: "B" },
  { id: "zone", icon: IconZone, label: "Zone", hotkey: "Z" },
  { id: "inspect", icon: IconInspect, label: "Inspect", hotkey: "I" },
  { id: "delete", icon: IconDelete, label: "Delete", hotkey: "X" },
];

function Tooltip({ lines }: { lines: string[] }) {
  return (
    <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2.5 py-1.5 text-center text-[11px] font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100">
      {lines.map((line, i) => (
        <span key={i} className={i === 0 ? "block font-semibold" : "block text-[9.5px] text-zinc-300"}>
          {line}
        </span>
      ))}
    </span>
  );
}

function DockButton({
  active,
  icon: Icon,
  label,
  hotkey,
  onClick,
}: {
  active: boolean;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  hotkey: string;
  onClick: () => void;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        data-active={active}
        aria-label={label}
        className="icon-btn h-12 w-12"
      >
        <Icon className="h-5 w-5" />
      </button>
      <Tooltip lines={[label, `Key: ${hotkey}`]} />
    </div>
  );
}

/** Cross-Section / Road Type selector — every road class plus the Texas Turnaround prefab, since picking Turnaround is really picking "what to draw next" just like picking Highway is. */
function RoadClassPanel() {
  const selectedRoadClassId = useEditorStore((s) => s.selectedRoadClassId);
  const setRoadClass = useEditorStore((s) => s.setRoadClass);
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);

  return (
    <div className="hud-panel flex max-w-[calc(100vw-2rem)] items-stretch gap-1 overflow-x-auto rounded-2xl p-2">
      {ROAD_CLASS_LIST.map((cls, i) => {
        const active = tool === "draw" && selectedRoadClassId === cls.id;
        const pricePerFt = Math.round(cls.costPerFtPerLane * cls.lanesPerDirection);
        return (
          <div key={cls.id} className="group relative">
            <button
              type="button"
              onClick={() => {
                setTool("draw");
                setRoadClass(cls.id);
              }}
              className={`flex w-20 flex-col items-center gap-1.5 rounded-xl px-1.5 py-2 transition active:scale-95 ${
                active
                  ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm"
                  : "text-zinc-700 hover:bg-black/5"
              }`}
            >
              <div className="flex h-6 w-14 flex-col items-center justify-center gap-[3px] rounded-sm bg-[#3a4155] p-1">
                {Array.from({ length: cls.lanesPerDirection }).map((_, laneIdx) => (
                  <span key={laneIdx} className="h-[1.5px] w-full bg-white/70" />
                ))}
              </div>
              <span className="text-[10px] font-semibold leading-none">{cls.label}</span>
              <span className={`text-[9px] leading-none ${active ? "text-white/80" : "text-zinc-500"}`}>
                ${pricePerFt}/ft
              </span>
            </button>
            <Tooltip lines={[cls.label, `Key: ${i + 1} · ${cls.speedLimitMph} mph design speed`]} />
          </div>
        );
      })}

      <div className="w-px self-stretch bg-black/10" />

      <div className="group relative">
        <button
          type="button"
          onClick={() => setTool("turnaround")}
          className={`flex w-20 flex-col items-center gap-1.5 rounded-xl px-1.5 py-2 transition active:scale-95 ${
            tool === "turnaround"
              ? "bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-sm"
              : "text-zinc-700 hover:bg-black/5"
          }`}
        >
          <div className="flex h-6 w-14 items-center justify-center rounded-sm bg-[#3a4155] p-1">
            <IconTurnaround className="h-4 w-4 text-white/80" />
          </div>
          <span className="text-[10px] font-semibold leading-none">Turnaround</span>
          <span className={`text-[9px] leading-none ${tool === "turnaround" ? "text-white/80" : "text-zinc-500"}`}>
            prefab
          </span>
        </button>
        <Tooltip lines={["Texas Turnaround", `Key: T · ${TEXAS_TURNAROUND_SPEED_MPH} mph design speed`]} />
      </div>
    </div>
  );
}

/** Below-grade (cut/tunnel) vs at-or-above-grade (fill/elevated) — civil-engineering color coding: excavation is warm concrete-brown, structure is cool concrete-slate. */
const BELOW_GRADE_IDS = new Set(["tunnel", "cutting"]);

function ElevationPanel() {
  const selectedElevationId = useEditorStore((s) => s.selectedElevationId);
  const setElevation = useEditorStore((s) => s.setElevation);
  const twoWay = useEditorStore((s) => s.twoWay);
  const setTwoWay = useEditorStore((s) => s.setTwoWay);
  const drawFromNodeId = useEditorStore((s) => s.drawFromNodeId);
  const cancelDrawChain = useEditorStore((s) => s.cancelDrawChain);

  return (
    <div className="hud-panel flex flex-col gap-2 rounded-2xl p-2.5">
      <span className="text-center text-[9.5px] font-bold uppercase tracking-wider text-zinc-400">Elevation</span>
      <div className="flex items-stretch gap-1">
        {ELEVATION_LEVELS.map((lvl, i) => {
          const active = selectedElevationId === lvl.id;
          const belowGrade = BELOW_GRADE_IDS.has(lvl.id);
          const isDividerBoundary = i > 0 && belowGrade !== BELOW_GRADE_IDS.has(ELEVATION_LEVELS[i - 1].id);
          const stepsWithE = HOTKEY_TIER_IDS.includes(lvl.id) && lvl.id !== "ground";
          const ftLabel = `${lvl.elevationFt >= 0 ? "+" : ""}${lvl.elevationFt}ft`;
          return (
            <div key={lvl.id} className="flex items-stretch gap-1">
              {isDividerBoundary && <div className="w-px self-stretch bg-black/10" />}
              <div className="group relative">
                <button
                  type="button"
                  onClick={() => setElevation(lvl.id)}
                  className={`relative flex w-11 flex-col items-center gap-1 rounded-lg py-1.5 text-[8px] font-medium leading-none transition active:scale-95 ${
                    active
                      ? belowGrade
                        ? "bg-gradient-to-br from-amber-700 to-amber-900 text-white shadow-sm"
                        : "bg-gradient-to-br from-slate-500 to-slate-700 text-white shadow-sm"
                      : "text-zinc-600 hover:bg-black/5"
                  }`}
                >
                  {stepsWithE && (
                    <span
                      className={`absolute -top-1.5 right-0.5 rounded-full px-1 text-[7px] font-bold leading-tight ${
                        active ? "bg-white/25 text-white" : "bg-sky-500/15 text-sky-700"
                      }`}
                    >
                      E
                    </span>
                  )}
                  <span
                    className="w-1.5 rounded-full bg-current"
                    style={{ height: 4 + ((lvl.elevationFt + 35) / 95) * 16 }}
                  />
                  {lvl.label}
                </button>
                <Tooltip lines={[`${lvl.label} · ${ftLabel}`, stepsWithE ? "Key: E to step up" : lvl.id === "ground" ? "Key: Q to step down" : "Pick directly"]} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-center text-[9.5px] font-semibold uppercase tracking-wide text-zinc-400">Q / E to step tier</p>
      <label className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-600">
        <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} className="accent-sky-600" />
        Two-way
      </label>
      {drawFromNodeId && (
        <button
          type="button"
          onClick={cancelDrawChain}
          className="animate-pop rounded-lg bg-gradient-to-br from-pink-500 to-rose-500 px-2 py-1.5 text-[11px] font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
        >
          Finish road (Esc) ✓
        </button>
      )}
    </div>
  );
}

export default function ToolDock() {
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const buildLocked = useEditorStore((s) => s.buildLocked);

  if (mode !== "build" || buildLocked) return null;

  return (
    <div className="pointer-events-auto absolute bottom-20 left-1/2 z-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2">
      {(tool === "draw" || tool === "turnaround") && (
        <div className="animate-pop flex max-w-[calc(100vw-2rem)] items-end gap-2 overflow-x-auto">
          <RoadClassPanel />
          {tool === "draw" && <ElevationPanel />}
        </div>
      )}

      <div className="hud-panel flex items-center gap-1.5 rounded-2xl p-1.5">
        {TOOLS.map((t) => (
          <DockButton
            key={t.id}
            active={tool === t.id}
            icon={t.icon}
            label={t.label}
            hotkey={t.hotkey}
            onClick={() => setTool(t.id)}
          />
        ))}
      </div>
    </div>
  );
}
