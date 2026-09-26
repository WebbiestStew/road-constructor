"use client";

import { useState } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";

const SPEED_OPTIONS = [1, 2, 5, 10];
const DEFAULT_DEMAND = 900;
const MAX_DEMAND = 2400;

interface SimControlsProps {
  sim: UseTrafficSimulationReturn;
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

export default function SimControls({ sim }: SimControlsProps) {
  const { metrics, entries, running, speedMultiplier, ready, setRunning, setSpeedMultiplier, setDemand } = sim;
  const [demandByEntry, setDemandByEntry] = useState<Record<string, number>>({});

  const demandFor = (entryId: string) => demandByEntry[entryId] ?? DEFAULT_DEMAND;

  const handleDemandChange = (entryId: string, value: number) => {
    setDemandByEntry((prev) => ({ ...prev, [entryId]: value }));
    setDemand(entryId, value);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div className="hud-panel hud-scrollbar pointer-events-auto absolute left-4 top-4 flex w-80 max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-y-auto rounded-2xl p-4 text-zinc-100 shadow-2xl">
        <div>
          <h1 className="text-sm font-semibold tracking-wide text-zinc-50">
            Road Constructor
          </h1>
          <p className="text-xs text-zinc-400">
            3D microscopic traffic simulation &middot; IDM + MOBIL
          </p>
        </div>

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
                  speedMultiplier === mult
                    ? "bg-sky-500 text-white"
                    : "text-zinc-300 hover:bg-white/10"
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

        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Entry Demand
          </h2>
          {entries.length === 0 && (
            <p className="text-xs text-zinc-500">Connecting to simulation worker…</p>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-300">{entry.label}</span>
                <span className="font-medium text-zinc-100 tabular-nums">
                  {demandFor(entry.id)} veh/h
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={MAX_DEMAND}
                step={50}
                value={demandFor(entry.id)}
                onChange={(e) => handleDemandChange(entry.id, Number(e.target.value))}
              />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1 border-t border-white/10 pt-3 text-[11px] text-zinc-500">
          <span>Total spawned: {metrics.spawnedTotal}</span>
          <span>Drag to orbit &middot; scroll to zoom</span>
        </div>
      </div>
    </div>
  );
}

function formatSimTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
