"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContractStatus,
  EdgeSpeedRatio,
  WorkerInMessage,
  WorkerOutMessage,
} from "@/sim/types";
import { ftpsToMph } from "@/sim/types";
import type { EdgeTrafficStats } from "@/sim/los";
import { useEditorStore } from "@/state/editorStore";

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
  completedTripsTotal: number;
  contracts: ContractStatus[];
  edgeSpeedRatios: EdgeSpeedRatio[];
  problemEdgeIds: string[];
  edgeTrafficStats: EdgeTrafficStats[];
  gridlockPenaltyTotal: number;
  gridlockMarkers: [number, number, number][];
}

const DEFAULT_METRICS: SimMetricsState = {
  activeCount: 0,
  avgSpeedMph: 0,
  throughputPerMinute: 0,
  simTime: 0,
  spawnedTotal: 0,
  completedTripsTotal: 0,
  contracts: [],
  edgeSpeedRatios: [],
  problemEdgeIds: [],
  edgeTrafficStats: [],
  gridlockPenaltyTotal: 0,
  gridlockMarkers: [],
};

/** Fixed by default so the same network + demand reproduces the same traffic every time you "open to traffic" — lets you test whether a fix actually worked. */
const DEFAULT_SEED = 1337;

const METRICS_UPDATE_INTERVAL_MS = 200;

/**
 * Owns the dedicated simulation worker's lifecycle and exposes:
 *  - `snapshotRef`: a ref updated on every worker tick, read directly by
 *    VehicleRenderer inside its useFrame loop (never causes a React
 *    re-render — that would defeat the whole point of the worker).
 *  - throttled React `metrics` state, safe for the HUD to render normally.
 *  - control functions that post commands to the worker.
 *
 * The network itself lives in the editor store (src/state/editorStore.ts);
 * this hook watches that store's `mode` and pushes a full network resync to
 * the worker whenever Build -> Simulate is crossed.
 */
export function useTrafficSimulation() {
  const workerRef = useRef<Worker | null>(null);
  const snapshotRef = useRef<VehicleSnapshot | null>(null);
  const pendingReturnRef = useRef<{
    matrices: ArrayBuffer;
    colors: ArrayBuffer;
  } | null>(null);
  const versionCounterRef = useRef(0);
  const lastMetricsFlushRef = useRef(0);

  const [metrics, setMetrics] = useState<SimMetricsState>(DEFAULT_METRICS);
  const [userPaused, setUserPaused] = useState(false);
  const [speedMultiplier, setSpeedMultiplierState] = useState(1);
  const [ready, setReady] = useState(false);

  const mode = useEditorStore((s) => s.mode);
  const running = mode === "simulate" && !userPaused;

  useEffect(() => {
    const worker = new Worker(new URL("../sim/worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      if (msg.type === "ready") {
        setReady(true);
        return;
      }

      if (msg.type === "tick") {
        const pending = pendingReturnRef.current;
        if (pending) {
          worker.postMessage(
            {
              type: "returnBuffers",
              matrices: pending.matrices,
              colors: pending.colors,
            } satisfies WorkerInMessage,
            [pending.matrices, pending.colors],
          );
        }
        pendingReturnRef.current = {
          matrices: msg.matrices,
          colors: msg.colors,
        };

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
            completedTripsTotal: msg.completedTripsTotal,
            contracts: msg.contracts,
            edgeSpeedRatios: msg.edgeSpeedRatios,
            problemEdgeIds: msg.problemEdgeIds,
            edgeTrafficStats: msg.edgeTrafficStats,
            gridlockPenaltyTotal: msg.gridlockPenaltyTotal,
            gridlockMarkers: msg.gridlockMarkers,
          });
        }
      }
    };

    worker.postMessage({
      type: "setSpeedMultiplier",
      value: 1,
    } satisfies WorkerInMessage);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Cross Build -> Simulate: push a full network resync so the worker
  // always simulates exactly what's on screen.
  useEffect(() => {
    if (mode !== "simulate") return;
    const worker = workerRef.current;
    if (!worker) return;
    const snapshot = useEditorStore.getState().getSnapshot();
    worker.postMessage({
      type: "updateNetwork",
      network: snapshot,
      seed: DEFAULT_SEED,
    } satisfies WorkerInMessage);
  }, [mode]);

  // `running` is derived (mode === "simulate" && !userPaused); keep the
  // worker's clock in sync with it whenever either input changes.
  useEffect(() => {
    workerRef.current?.postMessage({
      type: "setRunning",
      running,
    } satisfies WorkerInMessage);
  }, [running]);

  const setRunning = useCallback((value: boolean) => {
    setUserPaused(!value);
  }, []);

  const setSpeedMultiplier = useCallback((value: number) => {
    setSpeedMultiplierState(value);
    workerRef.current?.postMessage({
      type: "setSpeedMultiplier",
      value,
    } satisfies WorkerInMessage);
  }, []);

  const setDemand = useCallback((edgeId: string, vehiclesPerHour: number) => {
    workerRef.current?.postMessage({
      type: "setDemand",
      edgeId,
      vehiclesPerHour,
    } satisfies WorkerInMessage);
  }, []);

  /** Re-sends the current network to the worker with the same fixed seed, restarting traffic from a clean slate without leaving Simulate mode. */
  const resetTraffic = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const snapshot = useEditorStore.getState().getSnapshot();
    worker.postMessage({
      type: "updateNetwork",
      network: snapshot,
      seed: DEFAULT_SEED,
    } satisfies WorkerInMessage);
  }, []);

  return {
    snapshotRef,
    metrics,
    running,
    speedMultiplier,
    ready,
    setRunning,
    setSpeedMultiplier,
    setDemand,
    resetTraffic,
  };
}

export type UseTrafficSimulationReturn = ReturnType<
  typeof useTrafficSimulation
>;
