"use client";

import { useMemo, type ComponentType, type ReactNode, type SVGProps } from "react";
import { assembleCached } from "@/sim/assembleCache";
import { ROAD_CLASSES } from "@/sim/roadClasses";
import { LANE_MOVES, type LaneMove } from "@/sim/types";
import { SPEED_LIMIT_CHOICES_MPH, useEditorStore } from "@/state/editorStore";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconClose,
  IconJunction,
  IconLanes,
  IconRoundabout,
  IconSignal,
  IconSpeedSign,
  IconWarning,
  IconYield,
} from "./icons";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

const MOVE_ICON: Record<LaneMove, IconType> = {
  left: IconArrowLeft,
  straight: IconArrowUp,
  right: IconArrowRight,
};
const MOVE_LABEL: Record<LaneMove, string> = { left: "Left", straight: "Straight", right: "Right" };

function Shell({
  icon: Icon,
  title,
  subtitle,
  onClose,
  children,
}: {
  icon: IconType;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="hud-panel flex flex-col gap-3 rounded-2xl p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border-2 border-[#2b1c40] bg-gradient-to-br from-violet-400 to-fuchsia-500 text-white">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm font-extrabold uppercase leading-tight text-[#241b3d]">{title}</div>
          {subtitle && <div className="truncate text-[10.5px] font-semibold text-zinc-500">{subtitle}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label="Deselect" className="text-zinc-400 hover:text-zinc-700">
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}

/** Shown when a manager tool is active but nothing is selected yet. */
export function ToolHintCard({ icon: Icon, title, body }: { icon: IconType; title: string; body: string }) {
  return (
    <div className="hud-panel flex items-start gap-2.5 rounded-2xl p-3.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border-2 border-[#2b1c40] bg-[#f1e9ff] text-[#43305f]">
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <div className="font-display text-sm font-extrabold uppercase leading-tight text-[#241b3d]">{title}</div>
        <p className="mt-0.5 text-[11.5px] font-semibold leading-snug text-zinc-600">{body}</p>
      </div>
    </div>
  );
}

function useSelectedEdge() {
  const selection = useEditorStore((s) => s.selection);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const network = useMemo(() => assembleCached(nodes, edges), [nodes, edges]);
  const spec = selection?.kind === "edge" ? edges.find((e) => e.id === selection.id) : undefined;
  const assembled = spec ? network.edgesById.get(spec.id) : undefined;
  return { spec, assembled };
}

export function LaneManagerCard() {
  const { spec, assembled } = useSelectedEdge();
  const setSelection = useEditorStore((s) => s.setSelection);
  const setLaneMoves = useEditorStore((s) => s.setLaneMoves);
  const resetLaneMoves = useEditorStore((s) => s.resetLaneMoves);
  if (!spec || !assembled) return null;

  const cls = ROAD_CLASSES[spec.roadClassId];
  const close = () => setSelection(null);
  const available = new Set<LaneMove>(assembled.nextMoves.values());
  const exits = LANE_MOVES.filter((m) => available.has(m));
  const isCustom = !!spec.laneMoves;

  if (assembled.laneAllowed === null) {
    return (
      <Shell icon={IconLanes} title="Lane arrows" subtitle={`${cls.label} · ${spec.lanes} lane${spec.lanes > 1 ? "s" : ""}`} onClose={close}>
        <p className="text-[11.5px] font-semibold leading-snug text-zinc-600">
          {assembled.nextEdgeIds.length === 0
            ? "This road ends here, so there's nothing to assign."
            : "This road has only one way out, so every lane goes the same way. Arrows matter on roads that split at a junction — pick one that does."}
        </p>
      </Shell>
    );
  }

  const uncovered = exits.filter((m) => !assembled.laneMoves.some((lane) => lane.includes(m)));

  const toggle = (lane: number, move: LaneMove) => {
    const current = assembled.laneMoves[lane];
    const next = current.includes(move) ? current.filter((m) => m !== move) : [...current, move];
    if (next.length === 0) return; // a lane always needs somewhere to go
    setLaneMoves(spec.id, lane, LANE_MOVES.filter((m) => next.includes(m)));
  };

  return (
    <Shell icon={IconLanes} title="Lane arrows" subtitle={`${cls.label} · ${spec.lanes} lane${spec.lanes > 1 ? "s" : ""} · ${isCustom ? "custom" : "automatic"}`} onClose={close}>
      <div className="flex items-end justify-between text-[10px] font-extrabold uppercase tracking-wide text-zinc-400">
        <span>← Left</span>
        <span>Right →</span>
      </div>

      {/* Cross-section: the road as seen heading up the page, leftmost lane first. */}
      <div className="flex gap-1 rounded-xl bg-[#3a4155] p-1.5">
        {Array.from({ length: spec.lanes }).map((_, lane) => (
          <div key={lane} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="flex h-12 w-full flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-white/30 bg-[#2c3142] text-white">
              {assembled.laneMoves[lane].map((m) => {
                const Icon = MOVE_ICON[m];
                return <Icon key={m} className="h-4 w-4" />;
              })}
            </div>
            <div className="flex flex-col gap-1">
              {exits.map((move) => {
                const Icon = MOVE_ICON[move];
                const on = assembled.laneMoves[lane].includes(move);
                return (
                  <button
                    key={move}
                    type="button"
                    title={`${on ? "Remove" : "Allow"} ${MOVE_LABEL[move].toLowerCase()} from lane ${lane + 1}`}
                    aria-pressed={on}
                    onClick={() => toggle(lane, move)}
                    className={`flex h-7 w-7 items-center justify-center rounded-lg border-2 transition active:scale-90 ${
                      on
                        ? "border-[#2b1c40] bg-gradient-to-br from-amber-300 to-orange-400 text-[#2b1c40] shadow-[0_2px_0_#2b1c40]"
                        : "border-white/20 bg-white/10 text-white/50 hover:bg-white/20"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {uncovered.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-orange-500/15 p-2.5 text-[11px] font-semibold leading-snug text-orange-800">
          <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          No lane is set to go {uncovered.map((m) => MOVE_LABEL[m].toLowerCase()).join(" or ")}. Drivers who need that will use any lane.
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold text-zinc-500">
          Exits here: {exits.map((m) => MOVE_LABEL[m].toLowerCase()).join(", ")}
        </span>
        {isCustom && (
          <button
            type="button"
            onClick={() => resetLaneMoves(spec.id)}
            className="rounded-lg bg-black/5 px-2.5 py-1 text-[11px] font-bold text-zinc-700 transition hover:bg-black/10 active:scale-95"
          >
            Reset to auto
          </button>
        )}
      </div>
    </Shell>
  );
}

export function SpeedLimitCard({ wholeRoad, setWholeRoad }: { wholeRoad: boolean; setWholeRoad: (v: boolean) => void }) {
  const { spec } = useSelectedEdge();
  const setSelection = useEditorStore((s) => s.setSelection);
  const setSpeedLimit = useEditorStore((s) => s.setSpeedLimit);
  if (!spec) return null;
  const cls = ROAD_CLASSES[spec.roadClassId];

  return (
    <Shell icon={IconSpeedSign} title="Speed limit" subtitle={`${cls.label} · now ${spec.speedLimitMph} mph`} onClose={() => setSelection(null)}>
      <div className="grid grid-cols-5 gap-2">
        {SPEED_LIMIT_CHOICES_MPH.map((mph) => {
          const active = spec.speedLimitMph === mph;
          return (
            <button
              key={mph}
              type="button"
              aria-pressed={active}
              onClick={() => setSpeedLimit(spec.id, mph, wholeRoad)}
              className={`font-display flex aspect-square items-center justify-center rounded-full border-[3.5px] bg-white text-sm font-extrabold tabular-nums text-[#241b3d] transition active:scale-90 ${
                active ? "scale-110 border-red-600 shadow-[0_0_0_3px_rgba(220,38,38,0.25)]" : "border-red-500/70 hover:scale-105"
              }`}
            >
              {mph}
            </button>
          );
        })}
      </div>
      <label className="flex items-center justify-between text-xs font-semibold text-zinc-600">
        <span>Apply to the whole road</span>
        <input type="checkbox" className="accent-fuchsia-600" checked={wholeRoad} onChange={(e) => setWholeRoad(e.target.checked)} />
      </label>
      <p className="text-[11px] leading-snug text-zinc-500">
        Drivers cruise near the limit, so a slow stretch slows everyone behind it. Changes both directions.
      </p>
    </Shell>
  );
}

export function JunctionCard({ allowRebuild }: { allowRebuild: boolean }) {
  const selection = useEditorStore((s) => s.selection);
  const nodesById = useEditorStore((s) => s.nodesById);
  const edges = useEditorStore((s) => s.edges);
  const setNodeControl = useEditorStore((s) => s.setNodeControl);
  const setSignalTiming = useEditorStore((s) => s.setSignalTiming);
  const convertNodeToRoundabout = useEditorStore((s) => s.convertNodeToRoundabout);
  const setSelection = useEditorStore((s) => s.setSelection);

  if (selection?.kind !== "node") return null;
  const node = nodesById.get(selection.id);
  if (!node) return null;
  const signal = node.control?.type === "signal" ? node.control : null;
  const legCount = new Set(
    edges
      .filter((e) => e.fromNodeId === node.id || e.toNodeId === node.id)
      .map((e) => (e.fromNodeId === node.id ? e.toNodeId : e.fromNodeId))
  ).size;

  return (
    <Shell icon={IconJunction} title="Junction" subtitle={`${legCount} roads meet here`} onClose={() => setSelection(null)}>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => setNodeControl(node.id, undefined)}
          className={`flex flex-col items-center gap-1 rounded-xl py-2.5 text-[11px] font-bold transition active:scale-95 ${
            !signal ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm" : "bg-black/5 text-zinc-600 hover:bg-black/10"
          }`}
        >
          <IconYield className="h-4 w-4" />
          Priority
        </button>
        <button
          type="button"
          onClick={() => setNodeControl(node.id, { type: "signal", groupA: [], groupB: [], greenDurationS: 20, allRedDurationS: 2 })}
          className={`flex flex-col items-center gap-1 rounded-xl py-2.5 text-[11px] font-bold transition active:scale-95 ${
            signal ? "bg-gradient-to-br from-sky-400 to-blue-500 text-white shadow-sm" : "bg-black/5 text-zinc-600 hover:bg-black/10"
          }`}
        >
          <IconSignal className="h-4 w-4" />
          Traffic light
        </button>
      </div>

      {signal ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-zinc-600">Green time per direction</span>
            <span className="font-bold tabular-nums text-zinc-900">{signal.greenDurationS}s</span>
          </div>
          <input
            type="range"
            min={5}
            max={60}
            step={1}
            value={signal.greenDurationS}
            onChange={(e) => setSignalTiming(node.id, Number(e.target.value))}
          />
          <p className="text-[11px] leading-snug text-zinc-500">
            Long greens move more cars per cycle but make side streets wait. Approaches are split into two phases by heading.
          </p>
        </div>
      ) : (
        <p className="text-[11px] leading-snug text-zinc-500">
          Higher-class roads get right of way; equal roads yield to whoever arrives first.
        </p>
      )}

      {allowRebuild ? (
        <button
          type="button"
          disabled={legCount < 2}
          onClick={() => convertNodeToRoundabout(node.id)}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 px-2.5 py-1.5 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <IconRoundabout className="h-3.5 w-3.5" />
          Make roundabout 🔄
        </button>
      ) : null}
    </Shell>
  );
}
