"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerInMessage, WorkerOutMessage } from "@/sim/types";
import { ftpsToMph } from "@/sim/types";

export interface VehicleSnapshot {
  matrices: Float32Array;
  colors: Float32Array;
  activeCount: number;
  version: number;
}

export interface SimMetricsState {
  activeCount: number;
  avgSpeedMph: number;
  throughputPerMinute: number;
  simTime: number;
  spawnedTotal: number;
}

export interface EntryInfo {
  id: string;
  label: string;
}

const DEFAULT_METRICS: SimMetricsState = {
  activeCount: 0,
  avgSpeedMph: 0,
  throughputPerMinute: 0,
  simTime: 0,
  spawnedTotal: 0,
};

const METRICS_UPDATE_INTERVAL_MS = 200;

/**
 * Owns the dedicated simulation worker's lifecycle and exposes:
 *  - `snapshotRef`: a ref updated on every worker tick, read directly by
 *    VehicleRenderer inside its useFrame loop (never causes a React
 *    re-render — that would defeat the whole point of the worker).
 *  - throttled React `metrics` state, safe for the HUD to render normally.
 *  - control functions that post commands to the worker.
 */
export function useTrafficSimulation() {
  const workerRef = useRef<Worker | null>(null);
  const snapshotRef = useRef<VehicleSnapshot | null>(null);
  const pendingReturnRef = useRef<{ matrices: ArrayBuffer; colors: ArrayBuffer } | null>(null);
  const versionCounterRef = useRef(0);
  const lastMetricsFlushRef = useRef(0);

  const [metrics, setMetrics] = useState<SimMetricsState>(DEFAULT_METRICS);
  const [entries, setEntries] = useState<EntryInfo[]>([]);
  const [running, setRunningState] = useState(true);
  const [speedMultiplier, setSpeedMultiplierState] = useState(1);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL("../sim/worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      if (msg.type === "ready") {
        setEntries(msg.entries);
        setReady(true);
        return;
      }

      if (msg.type === "tick") {
        const pending = pendingReturnRef.current;
        if (pending) {
          worker.postMessage(
            { type: "returnBuffers", matrices: pending.matrices, colors: pending.colors } satisfies WorkerInMessage,
            [pending.matrices, pending.colors]
          );
        }
        pendingReturnRef.current = { matrices: msg.matrices, colors: msg.colors };

        versionCounterRef.current += 1;
        snapshotRef.current = {
          matrices: new Float32Array(msg.matrices),
          colors: new Float32Array(msg.colors),
          activeCount: msg.activeCount,
          version: versionCounterRef.current,
        };

        const now = performance.now();
        if (now - lastMetricsFlushRef.current >= METRICS_UPDATE_INTERVAL_MS) {
          lastMetricsFlushRef.current = now;
          setMetrics({
            activeCount: msg.activeCount,
            avgSpeedMph: ftpsToMph(msg.avgSpeedFtS),
            throughputPerMinute: msg.throughputLastMinute,
            simTime: msg.simTime,
            spawnedTotal: msg.spawnedTotal,
          });
        }
      }
    };

    // Send initial control state once the worker is constructed.
    worker.postMessage({ type: "setRunning", running: true } satisfies WorkerInMessage);
    worker.postMessage({ type: "setSpeedMultiplier", value: 1 } satisfies WorkerInMessage);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const setRunning = useCallback((value: boolean) => {
    setRunningState(value);
    workerRef.current?.postMessage({ type: "setRunning", running: value } satisfies WorkerInMessage);
  }, []);

  const setSpeedMultiplier = useCallback((value: number) => {
    setSpeedMultiplierState(value);
    workerRef.current?.postMessage({ type: "setSpeedMultiplier", value } satisfies WorkerInMessage);
  }, []);

  const setDemand = useCallback((entryId: string, vehiclesPerHour: number) => {
    workerRef.current?.postMessage({
      type: "setDemand",
      entryId,
      vehiclesPerHour,
    } satisfies WorkerInMessage);
  }, []);

  return {
    snapshotRef,
    metrics,
    entries,
    running,
    speedMultiplier,
    ready,
    setRunning,
    setSpeedMultiplier,
    setDemand,
  };
}

export type UseTrafficSimulationReturn = ReturnType<typeof useTrafficSimulation>;
