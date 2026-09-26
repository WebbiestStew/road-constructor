"use client";

import { ELEVATION_LEVELS, ROAD_CLASS_LIST } from "@/sim/roadClasses";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore, type EditorTool } from "@/state/editorStore";

const SPEED_OPTIONS = [1, 2, 5, 10];
const MAX_DEMAND = 2400;

const TOOLS: { id: EditorTool; label: string; hint: string }[] = [
  {
    id: "draw",
    label: "Draw",
    hint: "Click to start a road, click again to extend it. Click an existing road to tap in a junction. Right-click or Esc to stop.",
  },
  { id: "delete", label: "Delete", hint: "Click a road or junction to demolish it (50% refund)." },
  {
    id: "inspect",
    label: "Inspect",
    hint: "Click a road or junction to edit its lanes, direction, class, or signal control.",
  },
  { id: "zone", label: "Zone", hint: "Click a road to cycle it: none → Entry → Destination → none." },
];

function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

function formatSimTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function MetricTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col rounded-lg bg-white/5 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wide text-zinc-400">{label}</span>
      <span className="text-lg font-semibold text-zinc-50 tabular-nums">
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-zinc-400">{unit}</span> : null}
      </span>
    </div>
  );
}

function SegmentedButtons<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg bg-white/5 p-1">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
            value === opt.id ? "bg-sky-500 text-white" : "text-zinc-300 hover:bg-white/10"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function BuildToolbar() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const selectedRoadClassId = useEditorStore((s) => s.selectedRoadClassId);
  const setRoadClass = useEditorStore((s) => s.setRoadClass);
  const selectedElevationId = useEditorStore((s) => s.selectedElevationId);
  const setElevation = useEditorStore((s) => s.setElevation);
  const twoWay = useEditorStore((s) => s.twoWay);
  const setTwoWay = useEditorStore((s) => s.setTwoWay);
  const budget = useEditorStore((s) => s.budget);
  const drawFromNodeId = useEditorStore((s) => s.drawFromNodeId);
  const cancelDrawChain = useEditorStore((s) => s.cancelDrawChain);
  const clearNetwork = useEditorStore((s) => s.clearNetwork);

  const activeTool = TOOLS.find((t) => t.id === tool)!;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Budget</span>
        <span className={`text-sm font-semibold tabular-nums ${budget < 0 ? "text-red-400" : "text-zinc-100"}`}>
          {formatMoney(budget)}
        </span>
      </div>

      <SegmentedButtons options={TOOLS.map((t) => ({ id: t.id, label: t.label }))} value={tool} onChange={setTool} />
      <p className="text-[11px] leading-snug text-zinc-500">{activeTool.hint}</p>

      {tool === "draw" && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-zinc-400">Road class (1-5)</span>
            <div className="grid grid-cols-1 gap-1">
              {ROAD_CLASS_LIST.map((cls) => (
                <button
                  key={cls.id}
                  type="button"
                  onClick={() => setRoadClass(cls.id)}
                  className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition ${
                    selectedRoadClassId === cls.id
                      ? "bg-sky-500 text-white"
                      : "bg-white/5 text-zinc-300 hover:bg-white/10"
                  }`}
                >
                  <span>{cls.label}</span>
                  <span className="text-[10px] opacity-80">
                    {cls.lanesPerDirection}×{cls.speedLimitMph}mph
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-zinc-400">Elevation</span>
            <SegmentedButtons
              options={ELEVATION_LEVELS.map((e) => ({ id: e.id, label: e.label }))}
              value={selectedElevationId}
              onChange={setElevation}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} />
            Two-way road
          </label>

          {drawFromNodeId && (
            <button
              type="button"
              onClick={cancelDrawChain}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/20"
            >
              Finish road
            </button>
          )}
        </>
      )}

      <SelectionInspector />

      <button
        type="button"
        onClick={() => {
          if (window.confirm("Clear the entire network? This cannot be undone.")) clearNetwork();
        }}
        className="mt-1 self-start text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-300"
      >
        Clear network
      </button>
    </div>
  );
}

function SelectionInspector() {
  const selection = useEditorStore((s) => s.selection);
  const edgesById = useEditorStore((s) => s.edgesById);
  const nodesById = useEditorStore((s) => s.nodesById);
  const setEdgeLanes = useEditorStore((s) => s.setEdgeLanes);
  const setEdgeOneWay = useEditorStore((s) => s.setEdgeOneWay);
  const setEdgeRoadClass = useEditorStore((s) => s.setEdgeRoadClass);
  const deleteEdge = useEditorStore((s) => s.deleteEdge);
  const setNodeControl = useEditorStore((s) => s.setNodeControl);
  const convertNodeToRoundabout = useEditorStore((s) => s.convertNodeToRoundabout);
  const setSelection = useEditorStore((s) => s.setSelection);
  const edges = useEditorStore((s) => s.edges);

  if (!selection) return null;

  if (selection.kind === "edge") {
    const edge = edgesById.get(selection.id);
    if (!edge) return null;
    const isOneWay = !edges.some((e) => e.fromNodeId === edge.toNodeId && e.toNodeId === edge.fromNodeId);
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-white/5 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-200">Road segment</span>
          <button type="button" onClick={() => setSelection(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
            ✕
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-zinc-300">
          <span>Lanes</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEdgeLanes(edge.id, edge.lanes - 1)}
              className="h-6 w-6 rounded bg-white/10 hover:bg-white/20"
            >
              −
            </button>
            <span className="w-4 text-center tabular-nums">{edge.lanes}</span>
            <button
              type="button"
              onClick={() => setEdgeLanes(edge.id, edge.lanes + 1)}
              className="h-6 w-6 rounded bg-white/10 hover:bg-white/20"
            >
              +
            </button>
          </div>
        </div>

        <label className="flex items-center justify-between text-xs text-zinc-300">
          <span>One-way</span>
          <input type="checkbox" checked={isOneWay} onChange={(e) => setEdgeOneWay(edge.id, e.target.checked)} />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Class</span>
          <SegmentedButtons
            options={ROAD_CLASS_LIST.map((c) => ({ id: c.id, label: c.label.split(" ")[0] }))}
            value={edge.roadClassId}
            onChange={(id) => setEdgeRoadClass(edge.id, id)}
          />
        </div>

        <button
          type="button"
          onClick={() => {
            deleteEdge(edge.id);
            setSelection(null);
          }}
          className="mt-1 rounded-md bg-red-500/20 px-2 py-1 text-xs font-medium text-red-300 hover:bg-red-500/30"
        >
          Demolish
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
    <div className="flex flex-col gap-2 rounded-lg bg-white/5 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-200">Junction</span>
        <button type="button" onClick={() => setSelection(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
          ✕
        </button>
      </div>
      <SegmentedButtons
        options={[
          { id: "priority", label: "Priority yield" },
          { id: "signal", label: "Traffic signal" },
        ]}
        value={isSignal ? "signal" : "priority"}
        onChange={(id) =>
          setNodeControl(node.id, id === "signal" ? { type: "signal", groupA: [], groupB: [], greenDurationS: 20, allRedDurationS: 2 } : undefined)
        }
      />
      <p className="text-[11px] text-zinc-500">
        {isSignal
          ? "Approaches are auto-grouped into two phases by heading; 20s green + 2s all-red each."
          : "Higher-class roads get right of way; equal-class approaches yield to whoever arrives first."}
      </p>
      <button
        type="button"
        disabled={legCount < 2}
        onClick={() => convertNodeToRoundabout(node.id)}
        className="mt-1 rounded-md bg-sky-500/20 px-2 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Make roundabout
      </button>
      {legCount < 2 && <p className="text-[11px] text-zinc-500">Needs at least 2 connected roads.</p>}
    </div>
  );
}

function SimulateHud({ sim }: { sim: UseTrafficSimulationReturn }) {
  const { metrics, running, speedMultiplier, ready, setRunning, setSpeedMultiplier, setDemand } = sim;
  const edges = useEditorStore((s) => s.edges);
  const setEntryDemand = useEditorStore((s) => s.setEntryDemand);

  const entries = edges.filter((e) => e.zone?.type === "entry");
  const destinations = edges.filter((e) => e.zone?.type === "destination");
  const contractsByEdge = new Map(metrics.contracts.map((c) => [c.edgeId, c]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setRunning(!running)}
          disabled={!ready}
          className="flex-1 rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-400 disabled:opacity-40"
        >
          {running ? "Pause" : "Play"}
        </button>
        <div className="flex items-center gap-1 rounded-lg bg-white/5 p-1">
          {SPEED_OPTIONS.map((mult) => (
            <button
              key={mult}
              type="button"
              onClick={() => setSpeedMultiplier(mult)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                speedMultiplier === mult ? "bg-sky-500 text-white" : "text-zinc-300 hover:bg-white/10"
              }`}
            >
              {mult}x
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MetricTile label="Active Vehicles" value={metrics.activeCount.toString()} />
        <MetricTile label="Avg Speed" value={metrics.avgSpeedMph.toFixed(0)} unit="mph" />
        <MetricTile label="Throughput" value={metrics.throughputPerMinute.toString()} unit="veh/min" />
        <MetricTile label="Sim Time" value={formatSimTime(metrics.simTime)} />
      </div>

      {entries.length === 0 || destinations.length === 0 ? (
        <p className="rounded-lg bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-300">
          Go back to Build, select the Zone tool, and mark at least one road as an Entry and one as a Destination —
          traffic only flows once both exist.
        </p>
      ) : null}

      {entries.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Entry Demand</h2>
          {entries.map((edge, i) => (
            <div key={edge.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-300">Entry {i + 1}</span>
                <span className="font-medium text-zinc-100 tabular-nums">
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
      )}

      {destinations.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Contracts</h2>
          {destinations.map((edge, i) => {
            const status = contractsByEdge.get(edge.id);
            const target = edge.zone?.type === "destination" ? edge.zone.targetSpeedMph : 0;
            const ok = status?.meetsThreshold ?? false;
            const hasData = (status?.sampleCount ?? 0) > 0;
            return (
              <div key={edge.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-xs">
                <span className="text-zinc-300">Destination {i + 1}</span>
                <span className={`font-medium tabular-nums ${!hasData ? "text-zinc-500" : ok ? "text-emerald-400" : "text-red-400"}`}>
                  {hasData ? `${status!.actualSpeedMph.toFixed(0)} / ${target} mph` : `target ${target} mph`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-1 border-t border-white/10 pt-3 text-[11px] text-zinc-500">
        <span>Total spawned: {metrics.spawnedTotal}</span>
      </div>
    </div>
  );
}

export default function SimControls({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div className="hud-panel hud-scrollbar pointer-events-auto absolute left-4 top-4 flex w-96 max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-y-auto rounded-2xl p-4 text-zinc-100 shadow-2xl">
        <div>
          <h1 className="text-sm font-semibold tracking-wide text-zinc-50">Road Constructor</h1>
          <p className="text-xs text-zinc-400">Design the network, then see if it holds up under traffic.</p>
        </div>

        <SegmentedButtons
          options={[
            { id: "build", label: "Build" },
            { id: "simulate", label: "Open to Traffic" },
          ]}
          value={mode}
          onChange={setMode}
        />

        {mode === "build" ? <BuildToolbar /> : <SimulateHud sim={sim} />}

        <div className="border-t border-white/10 pt-2 text-[11px] text-zinc-500">
          Left-click to build/select &middot; right-drag to orbit &middot; middle-drag to pan &middot; scroll to zoom
        </div>
      </div>
    </div>
  );
}
