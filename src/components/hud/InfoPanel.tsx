"use client";

import type { ComponentType, SVGProps } from "react";
import { ROAD_CLASS_LIST } from "@/sim/roadClasses";
import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import {
  IconCar,
  IconClock,
  IconClose,
  IconFlag,
  IconGauge,
  IconRoundabout,
  IconSignal,
  IconYield,
} from "./icons";

const MAX_DEMAND = 2400;

function formatSimTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  gradient,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  value: string;
  unit?: string;
  gradient: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-black/[0.03] px-3 py-2.5">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm ${gradient}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[9.5px] uppercase tracking-wide text-zinc-500">{label}</span>
        <span className="font-display text-base font-bold leading-tight text-[#241b3d] tabular-nums">
          {value}
          {unit ? <span className="ml-1 text-[10px] font-normal text-zinc-500">{unit}</span> : null}
        </span>
      </div>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
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
  const convertNodeToRoundabout = useEditorStore((s) => s.convertNodeToRoundabout);
  const setSelection = useEditorStore((s) => s.setSelection);

  if (!selection) return null;

  if (selection.kind === "edge") {
    const edge = edgesById.get(selection.id);
    if (!edge) return null;
    const isOneWay = !edges.some((e) => e.fromNodeId === edge.toNodeId && e.toNodeId === edge.fromNodeId);
    return (
      <div className="hud-panel flex flex-col gap-3 rounded-2xl p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-800">Road segment</span>
          <button type="button" onClick={() => setSelection(null)} className="text-zinc-400 hover:text-zinc-700">
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
            <span className="w-4 text-center tabular-nums text-zinc-900">{edge.lanes}</span>
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

        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Class</span>
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
      .map((e) => (e.fromNodeId === node.id ? e.toNodeId : e.fromNodeId))
  ).size;

  return (
    <div className="hud-panel flex flex-col gap-3 rounded-2xl p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-800">Junction</span>
        <button type="button" onClick={() => setSelection(null)} className="text-zinc-400 hover:text-zinc-700">
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
      {legCount < 2 && <p className="text-[11px] text-zinc-500">Needs at least 2 connected roads.</p>}
    </div>
  );
}

function BuildInfo() {
  const clearNetwork = useEditorStore((s) => s.clearNetwork);
  const selection = useEditorStore((s) => s.selection);

  if (!selection) return null;

  return (
    <div className="flex w-72 flex-col gap-3">
      <SelectionInspector />

      <button
        type="button"
        onClick={() => {
          if (window.confirm("Clear the entire network? This cannot be undone.")) clearNetwork();
        }}
        className="self-end text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-700"
      >
        Clear network
      </button>
    </div>
  );
}

function SimulateInfo({ sim }: { sim: UseTrafficSimulationReturn }) {
  const { metrics, setDemand } = sim;
  const edges = useEditorStore((s) => s.edges);
  const setEntryDemand = useEditorStore((s) => s.setEntryDemand);

  const entries = edges.filter((e) => e.zone?.type === "entry");
  const destinations = edges.filter((e) => e.zone?.type === "destination");
  const contractsByEdge = new Map(metrics.contracts.map((c) => [c.edgeId, c]));

  return (
    <div className="hud-panel flex w-80 flex-col gap-4 rounded-2xl p-3.5">
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

      {(entries.length === 0 || destinations.length === 0) && (
        <p className="rounded-xl bg-amber-500/15 p-2.5 text-[11px] leading-snug text-amber-800">
          🚧 Ghost town! Hop back to Build, grab the Zone tool, and mark an Entry + a Destination — nobody&rsquo;s
          driving anywhere until then.
        </p>
      )}

      {entries.length > 0 && (
        <PanelSection title="Entry demand">
          <div className="flex flex-col gap-3">
            {entries.map((edge, i) => (
              <div key={edge.id} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-600">Entry {i + 1}</span>
                  <span className="font-medium text-zinc-900 tabular-nums">
                    {edge.zone?.type === "entry" ? edge.zone.demandVehPerHour : 0} veh/h
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={MAX_DEMAND}
                  step={50}
                  value={edge.zone?.type === "entry" ? edge.zone.demandVehPerHour : 0}
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
              const target = edge.zone?.type === "destination" ? edge.zone.targetSpeedMph : 0;
              const ok = status?.meetsThreshold ?? false;
              const hasData = (status?.sampleCount ?? 0) > 0;
              return (
                <div
                  key={edge.id}
                  className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-2 text-xs"
                >
                  <span className="flex items-center gap-1.5 text-zinc-600">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        !hasData ? "bg-zinc-400" : ok ? "bg-emerald-500" : "bg-red-500"
                      }`}
                    />
                    Destination {i + 1}
                  </span>
                  <span
                    className={`font-medium tabular-nums ${
                      !hasData ? "text-zinc-500" : ok ? "text-emerald-600" : "text-red-600"
                    }`}
                  >
                    {hasData ? `${status!.actualSpeedMph.toFixed(0)} / ${target} mph` : `target ${target} mph`}
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
  );
}

export default function InfoPanel({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);

  return (
    <div className="pointer-events-auto absolute right-4 top-20 z-20">
      {mode === "build" ? <BuildInfo /> : <SimulateInfo sim={sim} />}
    </div>
  );
}
