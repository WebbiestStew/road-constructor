"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContractStatus,
  EdgeSpec,
  EdgeSpeedRatio,
  JunctionControl,
  LaneMove,
  NodeSpec,
  WorkerInMessage,
  WorkerOutMessage,
} from "@/sim/types";
import { ftpsToMph } from "@/sim/types";
import { useEditorStore } from "@/state/editorStore";
import { VEHICLE_CAP, useQuality } from "@/lib/quality";

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
  contracts: ContractStatus[];
  edgeSpeedRatios: EdgeSpeedRatio[];
  problemEdgeIds: string[];
}

const DEFAULT_METRICS: SimMetricsState = {
  activeCount: 0,
  avgSpeedMph: 0,
  throughputPerMinute: 0,
  simTime: 0,
  spawnedTotal: 0,
  contracts: [],
  edgeSpeedRatios: [],
  problemEdgeIds: [],
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
  const pendingReturnRef = useRef<{ matrices: ArrayBuffer; colors: ArrayBuffer } | null>(null);
  const versionCounterRef = useRef(0);
  const lastMetricsFlushRef = useRef(0);

  const [metrics, setMetrics] = useState<SimMetricsState>(DEFAULT_METRICS);
  const [userPaused, setUserPaused] = useState(false);
  const [speedMultiplier, setSpeedMultiplierState] = useState(1);
  const [ready, setReady] = useState(false);
  const [workerFailed, setWorkerFailed] = useState(false);
  const quality = useQuality();

  const mode = useEditorStore((s) => s.mode);
  const simEpoch = useEditorStore((s) => s.simEpoch);
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
            contracts: msg.contracts,
            edgeSpeedRatios: msg.edgeSpeedRatios,
            problemEdgeIds: msg.problemEdgeIds,
          });
        }
      }
    };

    worker.onerror = (event) => {
      console.error("Simulation worker crashed:", event.message);
      setWorkerFailed(true);
    };
    worker.onmessageerror = () => setWorkerFailed(true);

    worker.postMessage({ type: "setSpeedMultiplier", value: 1 } satisfies WorkerInMessage);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "setMaxVehicles", value: VEHICLE_CAP[quality] } satisfies WorkerInMessage);
  }, [quality]);

  // Cross Build -> Simulate: push a full network resync so the worker
  // always simulates exactly what's on screen. While simulating, keep it in
  // sync with live traffic-management edits (speed limits, lane arrows,
  // junction control) via small patches, so the sim is never restarted.
  useEffect(() => {
    if (mode !== "simulate") return;
    const worker = workerRef.current;
    if (!worker) return;
    const snapshot = useEditorStore.getState().getSnapshot();
    // Every time traffic opens (or a level restarts) is a fresh run from t = 0, so the fixed seed really does
    // replay the same traffic and a fix can be judged against the last attempt.
    worker.postMessage({ type: "reset" } satisfies WorkerInMessage);
    worker.postMessage({ type: "updateNetwork", network: snapshot, seed: DEFAULT_SEED } satisfies WorkerInMessage);

    const edgeSig = (e: EdgeSpec) => `${e.speedLimitMph}|${JSON.stringify(e.laneMoves ?? null)}`;
    const nodeSig = (n: NodeSpec) => JSON.stringify(n.control ?? null);
    let sentEdges = new Map(snapshot.edges.map((e) => [e.id, edgeSig(e)]));
    let sentNodes = new Map(snapshot.nodes.map((n) => [n.id, nodeSig(n)]));

    const structureSig = (edges: EdgeSpec[], nodes: NodeSpec[]) =>
      `${edges.map((e) => `${e.id}:${e.fromNodeId}>${e.toNodeId}:${e.lanes}`).join(",")}|${nodes.map((n) => n.id).join(",")}`;
    let sentStructure = structureSig(snapshot.edges, snapshot.nodes);

    return useEditorStore.subscribe((state) => {
      // A roads-changed edit (e.g. a junction turned into a roundabout) needs the whole network re-sent; the
      // worker keeps vehicles that are still on roads that exist and drops the rest. The clock keeps running.
      const sig = structureSig(state.edges, state.nodes);
      if (sig !== sentStructure) {
        sentStructure = sig;
        const next = state.getSnapshot();
        worker.postMessage({ type: "updateNetwork", network: next, seed: DEFAULT_SEED } satisfies WorkerInMessage);
        sentEdges = new Map(next.edges.map((e) => [e.id, edgeSig(e)]));
        sentNodes = new Map(next.nodes.map((n) => [n.id, nodeSig(n)]));
        return;
      }

      const edgePatches: { id: string; speedLimitMph: number; laneMoves: LaneMove[][] | null }[] = [];
      for (const e of state.edges) {
        const sig = edgeSig(e);
        if (sentEdges.get(e.id) === sig) continue;
        sentEdges.set(e.id, sig);
        edgePatches.push({ id: e.id, speedLimitMph: e.speedLimitMph, laneMoves: e.laneMoves ?? null });
      }
      if (edgePatches.length > 0) {
        worker.postMessage({ type: "patchEdges", edges: edgePatches } satisfies WorkerInMessage);
      }
      const nodePatches: { id: string; control: JunctionControl | null }[] = [];
      for (const n of state.nodes) {
        const sig = nodeSig(n);
        if (sentNodes.get(n.id) === sig) continue;
        sentNodes.set(n.id, sig);
        nodePatches.push({ id: n.id, control: n.control ?? null });
      }
      if (nodePatches.length > 0) {
        worker.postMessage({ type: "patchNodes", nodes: nodePatches } satisfies WorkerInMessage);
      }
    });
  }, [mode, simEpoch]);

  // `running` is derived (mode === "simulate" && !userPaused); keep the
  // worker's clock in sync with it whenever either input changes.
  useEffect(() => {
    workerRef.current?.postMessage({ type: "setRunning", running } satisfies WorkerInMessage);
  }, [running]);

  const setRunning = useCallback((value: boolean) => {
    setUserPaused(!value);
  }, []);

  const setSpeedMultiplier = useCallback((value: number) => {
    setSpeedMultiplierState(value);
    workerRef.current?.postMessage({ type: "setSpeedMultiplier", value } satisfies WorkerInMessage);
  }, []);

  const setDemand = useCallback((edgeId: string, vehiclesPerHour: number) => {
    workerRef.current?.postMessage({
      type: "setDemand",
      edgeId,
      vehiclesPerHour,
    } satisfies WorkerInMessage);
  }, []);

  return {
    snapshotRef,
    metrics,
    running,
    speedMultiplier,
    ready,
    workerFailed,
    setRunning,
    setSpeedMultiplier,
    setDemand,
  };
}

export type UseTrafficSimulationReturn = ReturnType<typeof useTrafficSimulation>;
