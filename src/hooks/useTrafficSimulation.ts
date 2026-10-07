"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContractStatus,
  Weather,
  CrashStats,
  EmergencyStats,
  EdgePatch,
  EdgeSpec,
  EdgeSpeedRatio,
  IncidentView,
  JunctionControl,
  NodeSpec,
  WorkerInMessage,
  WorkerOutMessage,
} from "@/sim/types";
import { ftpsToMph } from "@/sim/types";
import type { EdgeTrafficStats } from "@/sim/los";
import { useEditorStore } from "@/state/editorStore";
import { getScenarioById } from "@/sim/scenarios";
import { useGraphics } from "@/lib/quality";

export interface VehicleSnapshot {
  matrices: Float32Array;
  colors: Float32Array;
  taillightColors: Float32Array;
  activeCount: number;
  /** Crossings with people on the road right now (see WorkerOutMessage). */
  pedCrossings: number[][];
  /** World positions of ambulances on the road right now. */
  ambulances: [number, number, number][];
  /** Where heavy trucks are engine-braking down a grade right now (for the soundscape). */
  jakeBrakes: [number, number, number][];
  version: number;
}

export interface SimMetricsState {
  activeCount: number;
  avgSpeedMph: number;
  throughputPerMinute: number;
  simTime: number;
  spawnedTotal: number;
  completedTripsTotal: number;
  peopleMovedTotal: number;
  /** Service quality (see the worker's tick): lost time per trip and the longest queue. */
  tripDelayTotalS: number;
  tripFreeFlowTotalS: number;
  tripsTimed: number;
  queueNowFt: number;
  queuePeakFt: number;
  pedServedTotal: number;
  pedIncidentsTotal: number;
  emergency: EmergencyStats;
  crashes: CrashStats;
  weather: Weather;
  /** Hour of the simulated day (0-24) while the day cycle is on, else -1. */
  clockHour: number;
  contracts: ContractStatus[];
  edgeSpeedRatios: EdgeSpeedRatio[];
  problemEdgeIds: string[];
  edgeTrafficStats: EdgeTrafficStats[];
  gridlockPenaltyTotal: number;
  gridlockMarkers: [number, number, number][];
  incidentMarkers: [number, number, number][];
  /** Stalled trucks, debris and crashes on the road, with the state of the wrecker sent to each. */
  incidents: IncidentView[];
  /** Where stopped drivers are fuming, how many there are, and the flow combos earned so far. */
  rageMarkers: [number, number, number][];
  rageCount: number;
  combos: number;
  /** What each signalled approach's light shows: red, green, a left arrow on its own, or amber. */
  signalHeads: [string, number][];
}

const DEFAULT_METRICS: SimMetricsState = {
  activeCount: 0,
  avgSpeedMph: 0,
  throughputPerMinute: 0,
  simTime: 0,
  spawnedTotal: 0,
  completedTripsTotal: 0,
  peopleMovedTotal: 0,
  tripDelayTotalS: 0,
  tripFreeFlowTotalS: 0,
  tripsTimed: 0,
  queueNowFt: 0,
  queuePeakFt: 0,
  pedServedTotal: 0,
  pedIncidentsTotal: 0,
  emergency: { dispatched: 0, completed: 0, waiting: 0, active: 0, totalResponseS: 0, totalIdealS: 0, lastResponseS: 0, lastIdealS: 0 },
  crashes: { happened: 0, cleared: 0, open: 0, totalClearS: 0, lastClearS: 0 },
  weather: "clear",
  clockHour: -1,
  contracts: [],
  edgeSpeedRatios: [],
  problemEdgeIds: [],
  edgeTrafficStats: [],
  gridlockPenaltyTotal: 0,
  gridlockMarkers: [],
  incidentMarkers: [],
  incidents: [],
  rageMarkers: [],
  rageCount: 0,
  combos: 0,
  signalHeads: [],
};

/** Fixed by default so the same network + demand reproduces the same traffic every time you "open to traffic" — lets you test whether a fix actually worked. */
const DEFAULT_SEED = 1337;


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
/** Hands the active level's scripted events (surges, breakdowns) to the worker, timed from the start of the run. */
function postScenarioEvents(worker: Worker) {
  const id = useEditorStore.getState().activeScenarioId;
  const events = id ? getScenarioById(id)?.scriptedEvents : undefined;
  if (events && events.length > 0) worker.postMessage({ type: "scheduleEvents", events } satisfies WorkerInMessage);
}

/** Run-level switches for the active level: whether left turns give way (continuous-flow levels and free building do; the other levels were tuned without it). */
function postRunFlags(worker: Worker) {
  const id = useEditorStore.getState().activeScenarioId;
  const enabled = id ? getScenarioById(id)?.leftTurnsYield === true : true;
  worker.postMessage({ type: "setLeftTurnsYield", enabled } satisfies WorkerInMessage);
  // Desperate lane weaves are part of free play; the levels' baselines were measured without them.
  worker.postMessage({ type: "setRageWeaves", enabled: !id } satisfies WorkerInMessage);
}

export function useTrafficSimulation() {
  const workerRef = useRef<Worker | null>(null);
  const snapshotRef = useRef<VehicleSnapshot | null>(null);
  const pendingReturnRef = useRef<{
    matrices: ArrayBuffer;
    colors: ArrayBuffer;
    taillightColors: ArrayBuffer;
  } | null>(null);
  const versionCounterRef = useRef(0);

  const [metrics, setMetrics] = useState<SimMetricsState>(DEFAULT_METRICS);
  const [userPaused, setUserPaused] = useState(false);
  const [speedMultiplier, setSpeedMultiplierState] = useState(1);
  const [ready, setReady] = useState(false);
  const [workerFailed, setWorkerFailed] = useState(false);
  const graphics = useGraphics();

  const mode = useEditorStore((s) => s.mode);
  const simEpoch = useEditorStore((s) => s.simEpoch);
  const running = mode === "simulate" && !userPaused;

  // Opening traffic always starts it moving: a pause left over from the last run (a finished level pauses itself) must
  // not carry into the next one.
  useEffect(() => {
    if (mode !== "simulate") return;
    const raf = requestAnimationFrame(() => setUserPaused(false));
    return () => cancelAnimationFrame(raf);
  }, [mode, simEpoch]);
  const heatmapEnabled = useEditorStore((s) => s.heatmapEnabled);

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
              taillightColors: pending.taillightColors,
            } satisfies WorkerInMessage,
            [pending.matrices, pending.colors, pending.taillightColors],
          );
        }
        pendingReturnRef.current = {
          matrices: msg.matrices,
          colors: msg.colors,
          taillightColors: msg.taillightColors,
        };

        versionCounterRef.current += 1;
        snapshotRef.current = {
          matrices: new Float32Array(msg.matrices),
          colors: new Float32Array(msg.colors),
          taillightColors: new Float32Array(msg.taillightColors),
          activeCount: msg.activeCount,
          pedCrossings: msg.pedCrossings,
          ambulances: msg.ambulances,
          jakeBrakes: msg.jakeBrakes ?? [],
          version: versionCounterRef.current,
        };

        // The worker attaches the heavy per-edge stats only a few times a second (and once per change while
        // paused), so a React state update happens exactly then — not on every 30 Hz snapshot.
        const stats = msg.stats;
        if (stats) {
          setMetrics({
            activeCount: msg.activeCount,
            avgSpeedMph: ftpsToMph(msg.avgSpeedFtS),
            throughputPerMinute: msg.throughputLastMinute,
            simTime: msg.simTime,
            spawnedTotal: msg.spawnedTotal,
            completedTripsTotal: msg.completedTripsTotal,
            peopleMovedTotal: msg.peopleMovedTotal,
            tripDelayTotalS: msg.tripDelayTotalS ?? 0,
            tripFreeFlowTotalS: msg.tripFreeFlowTotalS ?? 0,
            tripsTimed: msg.tripsTimed ?? 0,
            queueNowFt: msg.queueNowFt ?? 0,
            queuePeakFt: msg.queuePeakFt ?? 0,
            pedServedTotal: msg.pedServedTotal,
            pedIncidentsTotal: msg.pedIncidentsTotal,
            emergency: msg.emergency,
            crashes: msg.crashes,
            weather: msg.weather,
            clockHour: msg.clockHour,
            contracts: stats.contracts,
            edgeSpeedRatios: stats.edgeSpeedRatios,
            problemEdgeIds: stats.problemEdgeIds,
            edgeTrafficStats: stats.edgeTrafficStats,
            gridlockPenaltyTotal: stats.gridlockPenaltyTotal,
            gridlockMarkers: stats.gridlockMarkers,
            incidentMarkers: stats.incidentMarkers,
            incidents: msg.incidents ?? [],
            rageMarkers: msg.rageMarkers ?? [],
            rageCount: msg.rageCount ?? 0,
            combos: msg.combos ?? 0,
            signalHeads: stats.signalHeads ?? [],
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
    workerRef.current?.postMessage({ type: "setMaxVehicles", value: graphics.vehicleCap } satisfies WorkerInMessage);
  }, [graphics.vehicleCap]);

  const manualWeather = useEditorStore((s) => s.weather);
  useEffect(() => {
    workerRef.current?.postMessage({ type: "setWeather", weather: manualWeather } satisfies WorkerInMessage);
  }, [manualWeather]);

  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  useEffect(() => {
    const level = timeOfDay === "night" ? 1 : timeOfDay === "dusk" ? 0.5 : 0;
    workerRef.current?.postMessage({ type: "setDarkness", level } satisfies WorkerInMessage);
  }, [timeOfDay]);

  const dayCycle = useEditorStore((s) => s.dayCycle);
  useEffect(() => {
    // Starts at 6 am; a day lasts eight minutes of sim time.
    workerRef.current?.postMessage({ type: "setDayCycle", enabled: dayCycle, startHour: 6, dayLengthS: 480 } satisfies WorkerInMessage);
  }, [dayCycle]);

  const transitLines = useEditorStore((s) => s.transitLines);
  useEffect(() => {
    workerRef.current?.postMessage({ type: "setTransit", lines: transitLines } satisfies WorkerInMessage);
  }, [transitLines]);

  const trafficMix = useEditorStore((s) => s.trafficMix);
  useEffect(() => {
    workerRef.current?.postMessage({ type: "setTrafficMix", bus: trafficMix.bus, bike: trafficMix.bike } satisfies WorkerInMessage);
  }, [trafficMix]);

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
    postScenarioEvents(worker);
    postRunFlags(worker);

    const edgeSig = (e: EdgeSpec) => `${e.speedLimitMph}|${JSON.stringify(e.laneMoves ?? null)}|${e.reservedLane ?? ""}|${e.crosswalk ? 1 : 0}|${e.busStop ? 1 : 0}|${e.parking ? 1 : 0}|${e.vslMph ?? ""}|${(e.closedLanes ?? []).join(".")}|${e.displacedLeft ? 1 : 0}`;
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

      const edgePatches: EdgePatch[] = [];
      for (const e of state.edges) {
        const sig = edgeSig(e);
        if (sentEdges.get(e.id) === sig) continue;
        sentEdges.set(e.id, sig);
        edgePatches.push({
          id: e.id,
          speedLimitMph: e.speedLimitMph,
          laneMoves: e.laneMoves ?? null,
          reservedLane: e.reservedLane ?? null,
          crosswalk: e.crosswalk ?? false,
          busStop: e.busStop ?? false,
          parking: e.parking ?? false,
          vslMph: e.vslMph ?? null,
          closedLanes: e.closedLanes ?? [],
          displacedLeft: e.displacedLeft ?? false,
        });
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
    workerRef.current?.postMessage({
      type: "setRunning",
      running,
    } satisfies WorkerInMessage);
  }, [running]);

  // Vehicles normally render their own fixed paint color; the heatmap
  // toggle switches them (and the road surface) over to live speed-ratio
  // tinting instead — kept in sync with the worker since that's where
  // per-vehicle colors are actually written into the snapshot buffer.
  useEffect(() => {
    workerRef.current?.postMessage({
      type: "setColorMode",
      heatmap: heatmapEnabled,
    } satisfies WorkerInMessage);
  }, [heatmapEnabled]);

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

  /** Breaks down one random moving car for a while, so traffic has to cope with a blockage (Chaos mode). */
  const triggerBreakdown = useCallback((durationS: number) => {
    workerRef.current?.postMessage({ type: "breakdown", durationS } satisfies WorkerInMessage);
  }, []);

  /** Causes a crash on an open stretch; it blocks its lane until police arrive. */
  const triggerCrash = useCallback(() => {
    workerRef.current?.postMessage({ type: "crash" } satisfies WorkerInMessage);
  }, []);

  /** Dispatches an ambulance from a random entry to a random exit; how fast it gets through is scored. */
  const triggerAmbulance = useCallback(() => {
    workerRef.current?.postMessage({ type: "ambulance" } satisfies WorkerInMessage);
  }, []);

  /** Re-sends the current network to the worker with the same fixed seed, restarting traffic from a clean slate without leaving Simulate mode. */
  const resetTraffic = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const snapshot = useEditorStore.getState().getSnapshot();
    worker.postMessage({ type: "reset" } satisfies WorkerInMessage);
    worker.postMessage({
      type: "updateNetwork",
      network: snapshot,
      seed: DEFAULT_SEED,
    } satisfies WorkerInMessage);
    postScenarioEvents(worker);
    postRunFlags(worker);
  }, []);

  /** Stalls an 18-wheeler, drops debris, or causes a fender bender somewhere on the open road. */
  const triggerIncident = useCallback((kind: "stall" | "debris" | "fender", edgeId?: string) => {
    workerRef.current?.postMessage({ type: "incident", kind, edgeId } satisfies WorkerInMessage);
  }, []);

  /** Sends a wrecker to an incident. */
  const dispatchWrecker = useCallback((incidentId: number) => {
    workerRef.current?.postMessage({ type: "dispatchWrecker", incidentId } satisfies WorkerInMessage);
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
    resetTraffic,
    triggerBreakdown,
    triggerAmbulance,
    triggerCrash,
    triggerIncident,
    dispatchWrecker,
  };
}

export type UseTrafficSimulationReturn = ReturnType<
  typeof useTrafficSimulation
>;
