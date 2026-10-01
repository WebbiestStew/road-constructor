"use client";

import { useMemo, useState, type ComponentType, type SVGProps } from "react";
import {
  ROAD_CLASSES,
  ROAD_CLASS_LIST,
  estimateEdgeCost,
  estimateEdgeUpkeepPerHour,
} from "@/sim/roadClasses";
import { LOS_COLOR, LOS_DESCRIPTIONS, type EdgeTrafficStats, type LOSGrade } from "@/sim/los";
import { computeGradePercent, MAX_GRADE_PERCENT } from "@/sim/grade";
import { assembleNetworkCached, computeRoute } from "@/sim/network";
import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { JunctionCard, LaneManagerCard, SpeedLimitCard, ToolHintCard } from "./ManagerPanels";
import { useEditLog } from "@/lib/editLog";
import CityMood from "./CityMood";
import {
  IconCar,
  IconClock,
  IconClose,
  IconFlag,
  IconGauge,
  IconJunction,
  IconLanes,
  IconRoundabout,
  IconSignal,
  IconSpeedSign,
  IconWarning,
  IconYield,
} from "./icons";

const MAX_DEMAND = 2400;

function formatSimTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const LOS_ORDER: LOSGrade[] = ["A", "B", "C", "D", "E", "F"];

/** Worst-case LOS grade among edges currently carrying traffic, or null if the network is empty. */
function computeNetworkLOS(stats: { vehicleCount: number; los: LOSGrade }[]): LOSGrade | null {
  let worst: LOSGrade | null = null;
  for (const s of stats) {
    if (s.vehicleCount <= 0) continue;
    if (!worst || LOS_ORDER.indexOf(s.los) > LOS_ORDER.indexOf(worst)) worst = s.los;
  }
  return worst;
}

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  gradient,
  color,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  value: string;
  unit?: string;
  gradient?: string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-black/[0.03] px-3 py-2.5">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white shadow-sm ${
          color ? "" : `bg-gradient-to-br ${gradient}`
        }`}
        style={color ? { backgroundColor: color } : undefined}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[9.5px] uppercase tracking-wide text-zinc-500">
          {label}
        </span>
        <span className="font-display text-base font-bold leading-tight text-[#241b3d] tabular-nums">
          {value}
          {unit ? (
            <span className="ml-1 text-[10px] font-normal text-zinc-500">
              {unit}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** A slim v/c-ratio bar: how much of a road's per-lane capacity is actually being used, colored by the same LOS scale as the grade badge. Clamped visually at 120% so a badly oversaturated segment still reads as "full", not off the chart. */
function VcRatioBar({ vcRatio, los, capacityVehPerHourPerLane }: { vcRatio: number; los: LOSGrade; capacityVehPerHourPerLane: number }) {
  const pct = Math.min(1, vcRatio / 1.2) * 100;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span>Capacity used</span>
        <span className="font-medium tabular-nums text-zinc-700">
          {Math.round(vcRatio * 100)}% of {capacityVehPerHourPerLane}/ln
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, backgroundColor: LOS_COLOR[los] }}
        />
      </div>
    </div>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h2>
      {children}
    </div>
  );
}

function SelectionInspector() {
  const selection = useEditorStore((s) => s.selection);
  const edgesById = useEditorStore((s) => s.edgesById);
  const nodesById = useEditorStore((s) => s.nodesById);
  const edges = useEditorStore((s) => s.edges);
  const setEdgeLanes = useEditorStore((s) => s.setEdgeLanes);
  const setEdgeOneWay = useEditorStore((s) => s.setEdgeOneWay);
  const setEdgeRoadClass = useEditorStore((s) => s.setEdgeRoadClass);
  const deleteEdge = useEditorStore((s) => s.deleteEdge);
  const setNodeControl = useEditorStore((s) => s.setNodeControl);
  const convertNodeToRoundabout = useEditorStore(
    (s) => s.convertNodeToRoundabout,
  );
  const setSelection = useEditorStore((s) => s.setSelection);

  if (!selection) return null;

  if (selection.kind === "edge") {
    const edge = edgesById.get(selection.id);
    if (!edge) return null;
    const isOneWay = !edges.some(
      (e) => e.fromNodeId === edge.toNodeId && e.toNodeId === edge.fromNodeId,
    );
    const fromNode = nodesById.get(edge.fromNodeId);
    const toNode = nodesById.get(edge.toNodeId);
    const gradePercent = fromNode && toNode ? computeGradePercent(fromNode.position, toNode.position) : 0;
    return (
      <div className="hud-panel flex flex-col gap-3 rounded-2xl p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-800">
            Road segment
          </span>
          <button
            type="button"
            onClick={() => setSelection(null)}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-zinc-600">
          <span>Lanes / direction</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEdgeLanes(edge.id, edge.lanes - 1)}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-black/5 hover:bg-black/10"
            >
              −
            </button>
            <span className="w-4 text-center tabular-nums text-zinc-900">
              {edge.lanes}
            </span>
            <button
              type="button"
              onClick={() => setEdgeLanes(edge.id, edge.lanes + 1)}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-black/5 hover:bg-black/10"
            >
              +
            </button>
          </div>
        </div>

        <label className="flex items-center justify-between text-xs text-zinc-600">
          <span>One-way</span>
          <input
            type="checkbox"
            className="accent-sky-600"
            checked={isOneWay}
            onChange={(e) => setEdgeOneWay(edge.id, e.target.checked)}
          />
        </label>

        <div className="flex items-center justify-between text-xs text-zinc-600">
          <span>Grade</span>
          <span
            className={`font-medium tabular-nums ${
              Math.abs(gradePercent) > MAX_GRADE_PERCENT ? "text-red-600" : "text-zinc-900"
            }`}
          >
            {gradePercent > 0 ? "+" : ""}
            {gradePercent.toFixed(1)}%
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            Class
          </span>
          <div className="flex flex-wrap gap-1">
            {ROAD_CLASS_LIST.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setEdgeRoadClass(edge.id, c.id)}
                className={`rounded-lg px-2 py-1 text-[11px] font-bold transition active:scale-95 ${
                  edge.roadClassId === c.id
                    ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm"
                    : "bg-black/5 text-zinc-600 hover:bg-black/10"
                }`}
              >
                {c.label.split(" ")[0]}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            deleteEdge(edge.id);
            setSelection(null);
          }}
          className="rounded-lg bg-gradient-to-br from-red-500 to-rose-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
        >
          💥 Demolish (50% refund)
        </button>
      </div>
    );
  }

  const node = nodesById.get(selection.id);
  if (!node) return null;
  const isSignal = node.control?.type === "signal";
  const legCount = new Set(
    edges
      .filter((e) => e.fromNodeId === node.id || e.toNodeId === node.id)
      .map((e) => (e.fromNodeId === node.id ? e.toNodeId : e.fromNodeId)),
  ).size;

  return (
    <div className="hud-panel flex flex-col gap-3 rounded-2xl p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-800">Junction</span>
        <button
          type="button"
          onClick={() => setSelection(null)}
          className="text-zinc-400 hover:text-zinc-700"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => setNodeControl(node.id, undefined)}
          className={`flex flex-col items-center gap-1 rounded-xl py-2.5 text-[11px] font-bold transition active:scale-95 ${
            !isSignal
              ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm"
              : "bg-black/5 text-zinc-600 hover:bg-black/10"
          }`}
        >
          <IconYield className="h-4 w-4" />
          Priority
        </button>
        <button
          type="button"
          onClick={() =>
            setNodeControl(node.id, {
              type: "signal",
              groupA: [],
              groupB: [],
              greenDurationS: 20,
              allRedDurationS: 2,
            })
          }
          className={`flex flex-col items-center gap-1 rounded-xl py-2.5 text-[11px] font-bold transition active:scale-95 ${
            isSignal
              ? "bg-gradient-to-br from-sky-400 to-blue-500 text-white shadow-sm"
              : "bg-black/5 text-zinc-600 hover:bg-black/10"
          }`}
        >
          <IconSignal className="h-4 w-4" />
          Signal
        </button>
      </div>

      <p className="text-[11px] leading-snug text-zinc-500">
        {isSignal
          ? "Approaches are auto-grouped into two phases by heading; 20s green + 2s all-red each."
          : "Higher-class roads get right of way; equal-class approaches yield to whoever arrives first."}
      </p>

      <button
        type="button"
        disabled={legCount < 2}
        onClick={() => convertNodeToRoundabout(node.id)}
        className="flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 px-2.5 py-1.5 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
      >
        <IconRoundabout className="h-3.5 w-3.5" />
        Make roundabout 🔄
      </button>
      {legCount < 2 && (
        <p className="text-[11px] text-zinc-500">
          Needs at least 2 connected roads.
        </p>
      )}
    </div>
  );
}

function BuildInfo() {
  const clearNetwork = useEditorStore((s) => s.clearNetwork);
  const selection = useEditorStore((s) => s.selection);

  if (!selection) return null;

  return (
    <div className="flex w-72 max-w-[calc(50vw-1.5rem)] flex-col gap-3">
      <SelectionInspector />

      <button
        type="button"
        onClick={() => {
          if (
            window.confirm("Clear the entire network? This cannot be undone.")
          )
            clearNetwork();
        }}
        className="self-end text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-700"
      >
        Clear network
      </button>
    </div>
  );
}

function LiveEdgeInspector({ sim }: { sim: UseTrafficSimulationReturn }) {
  const selection = useEditorStore((s) => s.selection);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const setSelection = useEditorStore((s) => s.setSelection);
  const network = useMemo(() => assembleNetworkCached(nodes, edges), [nodes, edges]);

  if (!selection || selection.kind !== "edge") return null;
  const edge = network.edgesById.get(selection.id);
  if (!edge) return null;

  const stats = sim.metrics.edgeTrafficStats.find((s) => s.edgeId === edge.id);
  const buildCost = estimateEdgeCost(edge.roadClassId, edge.elevationLevelId, edge.length, edge.lanes);
  const upkeepPerHour = estimateEdgeUpkeepPerHour(edge.roadClassId, edge.length, edge.lanes);
  const los = stats?.los ?? "A";
  const hasTraffic = (stats?.vehicleCount ?? 0) > 0;
  const fromNode = network.nodesById.get(edge.fromNodeId);
  const toNode = network.nodesById.get(edge.toNodeId);
  const gradePercent = fromNode && toNode ? computeGradePercent(fromNode.position, toNode.position) : 0;

  return (
    <div className="hud-panel flex flex-col gap-2.5 rounded-2xl p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-800">
          Road segment
        </span>
        <button
          type="button"
          onClick={() => setSelection(null)}
          className="text-zinc-400 hover:text-zinc-700"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2.5 rounded-xl bg-black/[0.03] px-3 py-2.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base font-black text-white shadow-sm"
          style={{ backgroundColor: LOS_COLOR[los] }}
        >
          {los}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[9.5px] uppercase tracking-wide text-zinc-500">
            Level of Service
          </span>
          <span className="font-display text-sm font-bold leading-tight text-[#241b3d]">
            {hasTraffic ? LOS_DESCRIPTIONS[los] : "No traffic yet"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard
          icon={IconCar}
          label="Density"
          value={stats ? stats.densityPerLane.toFixed(0) : "0"}
          unit="veh/mi/ln"
          gradient="from-sky-400 to-blue-500"
        />
        <StatCard
          icon={IconGauge}
          label="Avg speed"
          value={stats ? stats.avgSpeedMph.toFixed(0) : "0"}
          unit="mph"
          gradient="from-emerald-400 to-teal-500"
        />
        <StatCard
          icon={IconFlag}
          label="Flow"
          value={stats ? stats.flowPerLaneVehPerHour.toFixed(0) : "0"}
          unit="veh/h/ln"
          gradient="from-orange-400 to-amber-500"
        />
        <StatCard
          icon={IconGauge}
          label="v/c ratio"
          value={stats ? stats.vcRatio.toFixed(2) : "0.00"}
          gradient="from-violet-400 to-fuchsia-500"
        />
      </div>

      <VcRatioBar
        vcRatio={stats?.vcRatio ?? 0}
        los={los}
        capacityVehPerHourPerLane={ROAD_CLASSES[edge.roadClassId].capacityVehPerHourPerLane}
      />

      <div className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-2 text-xs">
        <span className="text-zinc-600">Grade</span>
        <span
          className={`font-medium tabular-nums ${
            Math.abs(gradePercent) > MAX_GRADE_PERCENT ? "text-red-600" : "text-zinc-900"
          }`}
        >
          {gradePercent > 0 ? "+" : ""}
          {gradePercent.toFixed(1)}%
        </span>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-2 text-xs">
        <span className="text-zinc-600">Build cost</span>
        <span className="font-medium tabular-nums text-zinc-900">
          ${Math.round(buildCost).toLocaleString()}
        </span>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-2 text-xs">
        <span className="text-zinc-600">Upkeep</span>
        <span className="font-medium tabular-nums text-zinc-900">
          ${upkeepPerHour.toFixed(2)}/hr
        </span>
      </div>
    </div>
  );
}

/** Live per-approach traffic stats for a selected junction during Simulate mode — the node-selection counterpart to LiveEdgeInspector, built entirely from the same edgeTrafficStats stream the road-segment view already reads (no worker changes). */
function LiveNodeInspector({ sim }: { sim: UseTrafficSimulationReturn }) {
  const selection = useEditorStore((s) => s.selection);
  const nodesById = useEditorStore((s) => s.nodesById);
  const edgesById = useEditorStore((s) => s.edgesById);
  const edges = useEditorStore((s) => s.edges);
  const setSelection = useEditorStore((s) => s.setSelection);

  if (!selection || selection.kind !== "node") return null;
  const node = nodesById.get(selection.id);
  if (!node) return null;

  const statsById = new Map(sim.metrics.edgeTrafficStats.map((s) => [s.edgeId, s]));
  const incoming = edges.filter((e) => e.toNodeId === node.id);
  const outgoing = edges.filter((e) => e.fromNodeId === node.id);
  const incomingStats = incoming
    .map((e) => statsById.get(e.id))
    .filter((s): s is EdgeTrafficStats => !!s);
  const vehiclesWaiting = incomingStats.reduce((sum, s) => sum + s.vehicleCount, 0);
  const worstLOS = computeNetworkLOS(incomingStats.map((s) => ({ vehicleCount: s.vehicleCount, los: s.los })));
  const control = node.control;
  const isSignal = control?.type === "signal";

  return (
    <div className="hud-panel flex flex-col gap-2.5 rounded-2xl p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-800">Junction</span>
        <button
          type="button"
          onClick={() => setSelection(null)}
          className="text-zinc-400 hover:text-zinc-700"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2.5 rounded-xl bg-black/[0.03] px-3 py-2.5">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm ${
            isSignal ? "bg-gradient-to-br from-sky-400 to-blue-500" : "bg-gradient-to-br from-violet-500 to-fuchsia-600"
          }`}
        >
          {isSignal ? <IconSignal className="h-4 w-4" /> : <IconYield className="h-4 w-4" />}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[9.5px] uppercase tracking-wide text-zinc-500">
            Control
          </span>
          <span className="font-display text-sm font-bold leading-tight text-[#241b3d]">
            {isSignal ? "Signalized" : "Priority / yield"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard
          icon={IconCar}
          label="Waiting"
          value={vehiclesWaiting.toString()}
          unit="veh"
          gradient="from-sky-400 to-blue-500"
        />
        <StatCard
          icon={IconSignal}
          label="Worst LOS"
          value={worstLOS ?? "—"}
          color={worstLOS ? LOS_COLOR[worstLOS] : undefined}
          gradient="from-zinc-400 to-zinc-500"
        />
      </div>

      {isSignal && control.type === "signal" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            Signal timing
          </span>
          <div className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-2 text-xs">
            <span className="text-zinc-600">Phase A / Phase B approaches</span>
            <span className="font-medium tabular-nums text-zinc-900">
              {control.groupA.length} / {control.groupB.length}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-2 text-xs">
            <span className="text-zinc-600">Green / all-red</span>
            <span className="font-medium tabular-nums text-zinc-900">
              {control.greenDurationS}s / {control.allRedDurationS}s
            </span>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          Approaches ({incoming.length + outgoing.length})
        </span>
        <div className="flex flex-col gap-1">
          {incoming.map((e) => {
            const stats = statsById.get(e.id);
            return (
              <div
                key={e.id}
                className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-1.5 text-[11px]"
              >
                <span className="flex items-center gap-1.5 text-zinc-600">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: stats ? LOS_COLOR[stats.los] : "#a1a1aa" }}
                  />
                  {ROAD_CLASSES[edgesById.get(e.id)?.roadClassId ?? "street"].label.split(" ")[0]} in
                </span>
                <span className="font-medium tabular-nums text-zinc-900">
                  {stats ? `${stats.vehicleCount} veh · ${stats.avgSpeedMph.toFixed(0)} mph` : "0 veh"}
                </span>
              </div>
            );
          })}
          {incoming.length === 0 && (
            <p className="text-[11px] text-zinc-500">No incoming approaches.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SimulateInfo({ sim }: { sim: UseTrafficSimulationReturn }) {
  const { metrics, setDemand } = sim;
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const setEntryDemand = useEditorStore((s) => s.setEntryDemand);
  // Campaign scenarios are balanced around their own fixed starting demand —
  // letting a player just drag it up bypasses the actual civil-engineering
  // puzzle (build enough capacity) in favor of a slider. Free-build/sandbox
  // keeps full control since there's no authored difficulty to protect.
  const activeScenarioId = useEditorStore((s) => s.activeScenarioId);
  const demandLocked = activeScenarioId !== null;
  const setSelection = useEditorStore((s) => s.setSelection);

  const entries = edges.filter((e) => e.zone?.type === "entry");
  const destinations = edges.filter((e) => e.zone?.type === "destination");
  const contractsByEdge = new Map(metrics.contracts.map((c) => [c.edgeId, c]));
  const networkLOS = computeNetworkLOS(metrics.edgeTrafficStats);

  // An entry with zero route to every destination spawns traffic that goes
  // nowhere — silently: no vehicles ever appear, but nothing else says why,
  // and the eventual LOS reading for an untouched road reads as a
  // misleadingly reassuring "A" (free flow, because free of any traffic at
  // all). Surfaced explicitly here rather than left for the player to
  // puzzle out from an all-zero metrics panel.
  const network = useMemo(() => assembleNetworkCached(nodes, edges), [nodes, edges]);
  const disconnectedEntryNumbers = useMemo(() => {
    if (entries.length === 0 || destinations.length === 0) return [];
    const numbers: number[] = [];
    entries.forEach((entryEdge, i) => {
      const reachable = destinations.some(
        (destEdge) => computeRoute(network, entryEdge.id, destEdge.id) !== null
      );
      if (!reachable) numbers.push(i + 1);
    });
    return numbers;
  }, [entries, destinations, network]);

  return (
    <div className="flex w-80 max-w-[calc(50vw-1.5rem)] flex-col gap-3">
      <LiveEdgeInspector sim={sim} />
      <LiveNodeInspector sim={sim} />
      <div className="hud-panel flex flex-col gap-4 rounded-2xl p-3.5">
        <div className="grid grid-cols-2 gap-2">
          <StatCard
            icon={IconCar}
            label="Active"
            value={metrics.activeCount.toString()}
            unit="veh"
            gradient="from-sky-400 to-blue-500"
          />
          <StatCard
            icon={IconGauge}
            label="Avg speed"
            value={metrics.avgSpeedMph.toFixed(0)}
            unit="mph"
            gradient="from-emerald-400 to-teal-500"
          />
          <StatCard
            icon={IconSignal}
            label="Network LOS"
            value={networkLOS ?? "—"}
            color={networkLOS ? LOS_COLOR[networkLOS] : undefined}
            gradient="from-zinc-400 to-zinc-500"
          />
          <StatCard
            icon={IconFlag}
            label="Flow rate"
            value={Math.round(metrics.throughputPerMinute * 60).toString()}
            unit="veh/h"
            gradient="from-orange-400 to-amber-500"
          />
          <StatCard
            icon={IconFlag}
            label="Throughput"
            value={metrics.throughputPerMinute.toString()}
            unit="/min"
            gradient="from-orange-400 to-amber-500"
          />
          <StatCard
            icon={IconClock}
            label="Sim time"
            value={formatSimTime(metrics.simTime)}
            gradient="from-violet-400 to-fuchsia-500"
          />
        </div>

        {metrics.gridlockPenaltyTotal > 0 && (
          <div className="flex items-center gap-2 rounded-xl bg-red-500/15 p-2.5 text-[11px] leading-snug text-red-800">
            <span className="animate-warn-pulse flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-red-500 to-rose-700">
              <IconWarning className="h-3.5 w-3.5" />
            </span>
            {metrics.gridlockPenaltyTotal === 1
              ? "1 vehicle gave up in gridlock and left the network."
              : `${metrics.gridlockPenaltyTotal} vehicles gave up in gridlock and left the network.`}
          </div>
        )}

        {metrics.problemEdgeIds.length > 0 && (
          <div className="flex items-center gap-2 rounded-xl bg-orange-500/15 p-2.5 text-[11px] leading-snug text-orange-800">
            <span className="animate-warn-pulse flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-red-600">
              <IconWarning className="h-3.5 w-3.5" />
            </span>
            {metrics.problemEdgeIds.length === 1
              ? "1 road is badly jammed — look for the flashing marker."
              : `${metrics.problemEdgeIds.length} roads are badly jammed — look for the flashing markers.`}
          </div>
        )}

        {(entries.length === 0 || destinations.length === 0) && (
          <p className="rounded-xl bg-amber-500/15 p-2.5 text-[11px] leading-snug text-amber-800">
            🚧 Ghost town! Hop back to Build, grab the Zone tool, and mark an
            Entry + a Destination — nobody&rsquo;s driving anywhere until then.
          </p>
        )}

        {disconnectedEntryNumbers.length > 0 && (
          <div className="flex items-center gap-2 rounded-xl bg-red-500/15 p-2.5 text-[11px] leading-snug text-red-800">
            <span className="animate-warn-pulse flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-red-500 to-rose-700">
              <IconWarning className="h-3.5 w-3.5" />
            </span>
            {disconnectedEntryNumbers.length === entries.length
              ? "🔌 No route from any Entry to any Destination — look for a gap or a piece that didn't connect."
              : `🔌 Entry ${disconnectedEntryNumbers.join(", ")} can't reach any Destination — look for a gap or a piece that didn't connect.`}
          </div>
        )}

        {entries.length > 0 && (
          <PanelSection title="Entry demand">
            <div className="flex flex-col gap-3">
              {entries.map((edge, i) => (
                <div key={edge.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <button
                      type="button"
                      onClick={() => setSelection({ kind: "edge", id: edge.id })}
                      title="Highlight this road on the map"
                      className="text-zinc-600 underline decoration-dotted underline-offset-2 hover:text-zinc-900"
                    >
                      Entry {i + 1}
                    </button>
                    <span className="font-medium text-zinc-900 tabular-nums">
                      {edge.zone?.type === "entry"
                        ? edge.zone.demandVehPerHour
                        : 0}{" "}
                      veh/h
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={MAX_DEMAND}
                    step={50}
                    disabled={demandLocked}
                    title={demandLocked ? "Demand is fixed for this scenario" : undefined}
                    className="disabled:cursor-not-allowed disabled:opacity-40"
                    value={
                      edge.zone?.type === "entry"
                        ? edge.zone.demandVehPerHour
                        : 0
                    }
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setEntryDemand(edge.id, value);
                      setDemand(edge.id, value);
                    }}
                  />
                </div>
              ))}
            </div>
          </PanelSection>
        )}

        {destinations.length > 0 && (
          <PanelSection title="Contracts">
            <div className="flex flex-col gap-1.5">
              {destinations.map((edge, i) => {
                const status = contractsByEdge.get(edge.id);
                const target =
                  edge.zone?.type === "destination"
                    ? edge.zone.targetSpeedMph
                    : 0;
                const ok = status?.meetsThreshold ?? false;
                const hasData = (status?.sampleCount ?? 0) > 0;
                return (
                  <div
                    key={edge.id}
                    className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-2 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => setSelection({ kind: "edge", id: edge.id })}
                      title="Highlight this road on the map"
                      className="flex items-center gap-1.5 text-zinc-600 underline decoration-dotted underline-offset-2 hover:text-zinc-900"
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          !hasData
                            ? "bg-zinc-400"
                            : ok
                              ? "bg-blue-500"
                              : "bg-red-500"
                        }`}
                      />
                      Destination {i + 1}
                    </button>
                    <span
                      className={`font-medium tabular-nums ${
                        !hasData
                          ? "text-zinc-500"
                          : ok
                            ? "text-blue-600"
                            : "text-red-600"
                      }`}
                    >
                      {hasData
                        ? `${status!.actualSpeedMph.toFixed(0)} / ${target} mph`
                        : `target ${target} mph`}
                    </span>
                  </div>
                );
              })}
            </div>
          </PanelSection>
        )}

        <div className="border-t border-black/10 pt-2 text-[11px] text-zinc-500">
          Total spawned: {metrics.spawnedTotal}
        </div>
      </div>
    </div>
  );
}

/** Your recent tweaks and what each one did to average speed, so you can see what actually worked. */
function EditHistoryCard() {
  const entries = useEditLog();
  if (entries.length === 0) return null;
  return (
    <div className="hud-panel flex flex-col gap-1.5 rounded-2xl p-3">
      <div className="text-[10.5px] font-extrabold uppercase tracking-wide text-zinc-500">Your changes</div>
      {entries.slice(0, 5).map((e) => (
        <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg bg-black/[0.03] px-2.5 py-1.5 text-[11px]">
          <span className="min-w-0 truncate font-semibold text-zinc-700">{e.label}</span>
          {e.delta === null ? (
            <span className="shrink-0 font-bold text-zinc-400">measuring…</span>
          ) : (
            <span
              className={`shrink-0 font-extrabold tabular-nums ${
                e.delta >= 1.5 ? "text-emerald-600" : e.delta <= -1.5 ? "text-rose-600" : "text-zinc-500"
              }`}
            >
              {e.delta >= 0 ? "+" : ""}
              {e.delta.toFixed(1)} mph
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** A compact live read-out so the effect of a lane/speed/junction change is visible right where you make it. */
function MiniStats({ sim }: { sim: UseTrafficSimulationReturn }) {
  const { metrics } = sim;
  return (
    <div className="hud-panel flex items-center justify-between gap-2 rounded-2xl px-3.5 py-2.5 text-[11px] font-bold text-zinc-600">
      <span>
        <b className="font-display text-base text-[#241b3d] tabular-nums">{metrics.avgSpeedMph.toFixed(0)}</b> mph
      </span>
      <span>
        <b className="font-display text-base text-[#241b3d] tabular-nums">{metrics.throughputPerMinute}</b> /min
      </span>
      <span>
        <b className="font-display text-base text-[#241b3d] tabular-nums">{metrics.activeCount}</b> cars
      </span>
      {metrics.problemEdgeIds.length > 0 && (
        <span className="flex items-center gap-1 text-orange-700">
          <IconWarning className="h-3.5 w-3.5" />
          {metrics.problemEdgeIds.length}
        </span>
      )}
    </div>
  );
}

/** The lane-arrow, speed-limit and junction tool cards (the Traffic Manager tools); null for every other tool. */
function ManagerToolCard() {
  const tool = useEditorStore((s) => s.tool);
  const selection = useEditorStore((s) => s.selection);
  const [wholeRoad, setWholeRoad] = useState(true);

  if (tool === "lanes") {
    return selection?.kind === "edge" ? (
      <LaneManagerCard />
    ) : (
      <ToolHintCard
        icon={IconLanes}
        title="Lane arrows"
        body="Click a road that splits at a junction, then choose which lanes may turn left, go straight or turn right."
      />
    );
  }
  if (tool === "speed") {
    return selection?.kind === "edge" ? (
      <SpeedLimitCard wholeRoad={wholeRoad} setWholeRoad={setWholeRoad} />
    ) : (
      <ToolHintCard
        icon={IconSpeedSign}
        title="Speed limits"
        body="Click a road, then pick a limit. Slow stretches back traffic up; fast ones move it along."
      />
    );
  }
  if (tool === "junction") {
    return selection?.kind === "node" ? (
      <JunctionCard allowRebuild />
    ) : (
      <ToolHintCard
        icon={IconJunction}
        title="Junctions"
        body="Click a glowing junction to switch between priority and a traffic light, and tune the light's timing."
      />
    );
  }
  return null;
}

export default function InfoPanel({
  sim,
}: {
  sim: UseTrafficSimulationReturn;
}) {
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const managing = tool === "lanes" || tool === "speed" || tool === "junction";

  return (
    <div className="pointer-events-auto absolute right-4 top-60 z-20 flex max-h-[calc(100vh-19rem)] w-80 flex-col gap-3 overflow-y-auto hud-scrollbar lg:top-20 lg:max-h-[calc(100vh-16rem)]">
      {mode === "simulate" && <CityMood sim={sim} />}
      {managing ? (
        <>
          {mode === "simulate" && <MiniStats sim={sim} />}
          <ManagerToolCard />
        </>
      ) : mode === "build" ? (
        <BuildInfo />
      ) : (
        <SimulateInfo sim={sim} />
      )}
      {mode === "simulate" && <EditHistoryCard />}
    </div>
  );
}
