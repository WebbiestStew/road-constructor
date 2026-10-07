"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContractStatus,
  Weather,
  CrashStats,
  DriveResult,
  DriveView,
  EmergencyStats,
  EdgePatch,
  EdgeSpec,
  EdgeSpeedRatio,
  IncidentView,
  LoggedAction,
  JunctionControl,
  NodeSpec,
  TransitStats,
  WorkerInMessage,
  WorkerOutMessage,
} from "@/sim/types";
import { ftpsToMph } from "@/sim/types";
import type { EdgeTrafficStats } from "@/sim/los";
import { useEditorStore } from "@/state/editorStore";
import { getScenarioById } from "@/sim/scenarios";
import type { Highlight } from "@/lib/replays";
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
  /** The vehicle the player is driving, as of this tick. */
  drive: DriveView | null;
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
  /** Car-seconds spent in toll express lanes so far this run. */
  expressVehicleS: number;
  /** How the bus service is running: headways, bunching, transfers. */
  transit: TransitStats;
  /** Demand against what the entries were set to (1 = as set), and which of the optional rules are on. */
  demandIndex: number;
  elasticOn: boolean;
  crashRiskOn: boolean;
  pedWaitsOn: boolean;
  riskCrashes: number;
  pedWait: { arrivals: number; waitTotalS: number; gaveUp: number };
  closedEdges: string[];
  /** Each ramp meter's light: red or green. */
  meters: [string, number][];
  /** True once the worker is running the replay that was last started (the numbers above are not from the run before it). */
  replayLive: boolean;
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
  expressVehicleS: 0,
  transit: { services: 0, headwayMeanS: 0, headwayCv: 0, boarded: 0, transfers: 0, heldS: 0 },
  demandIndex: 1,
  elasticOn: false,
  crashRiskOn: false,
  pedWaitsOn: false,
  riskCrashes: 0,
  pedWait: { arrivals: 0, waitTotalS: 0, gaveUp: 0 },
  closedEdges: [],
  meters: [],
  replayLive: false,
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
/** Compares this tick's stats with the last and notes anything worth a replay's highlight reel. */
function noteHighlights(h: { list: Highlight[]; prev: SimMetricsState | null; jam: { at: number; n: number } }, msg: Extract<WorkerOutMessage, { type: "tick" }>, problems: number) {
  const prev = h.prev;
  // a new run (the clock went back): start the reel again
  if (prev && msg.simTime < prev.simTime) {
    h.list = [];
    h.jam = { at: 0, n: 0 };
  }
  const add = (kind: Highlight["kind"], label: string) => {
    if (h.list.length >= 14 || h.list.some((x) => Math.abs(x.at - msg.simTime) < 6)) return;
    h.list.push({ at: Math.round(msg.simTime * 10) / 10, kind, label });
  };
  if (prev && msg.simTime >= prev.simTime) {
    if ((msg.combos ?? 0) > prev.combos) add("combo", `Flow combo #${msg.combos}`);
    if (msg.crashes.cleared > prev.crashes.cleared) add("clear", `Crash cleared in ${Math.round(msg.crashes.lastClearS)}s`);
    if (msg.emergency.completed > prev.emergency.completed && msg.emergency.lastIdealS > 0) add("ambulance", `Ambulance through at ×${(msg.emergency.lastResponseS / msg.emergency.lastIdealS).toFixed(1)}`);
    if ((msg.riskCrashes ?? 0) > prev.riskCrashes) add("crash", "A driver's mistake");
  }
  if (problems > h.jam.n) h.jam = { at: msg.simTime, n: problems };
}

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
  // The optional rules: a level says which it uses; free play uses whatever the player has switched on.
  const def = id ? getScenarioById(id) : undefined;
  const st = useEditorStore.getState();
  worker.postMessage({ type: "setElasticDemand", enabled: id ? def?.elasticDemand === true : st.elasticDemand } satisfies WorkerInMessage);
  worker.postMessage({ type: "setCrashRisk", enabled: id ? def?.crashRisk === true : st.crashRisk } satisfies WorkerInMessage);
  worker.postMessage({ type: "setPedWaits", enabled: id ? def?.pedWaits === true : st.pedWaits } satisfies WorkerInMessage);
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
  const lastDriveKeyRef = useRef("");
  /** The run number the worker was on when a replay was started: the replay is live once it reports a later one. */
  const replayFloorRef = useRef(Infinity);
  /** The actions that have shaped the current run, for saving a replay of it (see worker: LOGGED_TYPES). */
  const recordingRef = useRef<{ runId: number; actions: LoggedAction[] }>({ runId: -1, actions: [] });
  /** Moments of the current run worth jumping to, noted from the stats as they arrive, and what the last stats said. */
  const highlightsRef = useRef<{ list: Highlight[]; prev: SimMetricsState | null; jam: { at: number; n: number } }>({ list: [], prev: null, jam: { at: 0, n: 0 } });

  const [metrics, setMetrics] = useState<SimMetricsState>(DEFAULT_METRICS);
  const [userPaused, setUserPaused] = useState(false);
  const [speedMultiplier, setSpeedMultiplierState] = useState(1);
  const [ready, setReady] = useState(false);
  const [workerFailed, setWorkerFailed] = useState(false);
  const [driveResult, setDriveResult] = useState<DriveResult | null>(null);
  const graphics = useGraphics();

  const mode = useEditorStore((s) => s.mode);
  const simEpoch = useEditorStore((s) => s.simEpoch);
  /** A replay drives the worker itself (see playReplay): the live edit sync and the fresh-run preamble below stand aside. */
  const replaying = useEditorStore((s) => s.replay !== null);
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
          drive: msg.drive ?? null,
          version: versionCounterRef.current,
        };
        if (msg.runId !== undefined) {
          const rec = recordingRef.current;
          if (rec.runId !== msg.runId) {
            rec.runId = msg.runId;
            rec.actions = [];
          }
          if (msg.actions) for (const a of msg.actions) rec.actions.push(a);
        }
        // A drive that has just ended: keep its summary (the worker repeats it in every tick until the next drive).
        const result = msg.driveResult ?? null;
        const key = result ? `${result.elapsedS.toFixed(2)}|${result.score}|${result.distanceFt.toFixed(0)}` : "";
        if (key !== lastDriveKeyRef.current) {
          lastDriveKeyRef.current = key;
          setDriveResult(result);
        }

        // The worker attaches the heavy per-edge stats only a few times a second (and once per change while
        // paused), so a React state update happens exactly then — not on every 30 Hz snapshot.
        const stats = msg.stats;
        if (stats) {
          noteHighlights(highlightsRef.current, msg, stats.problemEdgeIds.length);
          highlightsRef.current.prev = {
            simTime: msg.simTime,
            combos: msg.combos ?? 0,
            crashes: msg.crashes,
            emergency: msg.emergency,
            riskCrashes: msg.riskCrashes ?? 0,
          } as SimMetricsState;
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
            expressVehicleS: msg.expressVehicleS ?? 0,
            transit: msg.transit ?? DEFAULT_METRICS.transit,
            demandIndex: msg.demandIndex ?? 1,
            elasticOn: msg.elasticOn ?? false,
            crashRiskOn: msg.crashRiskOn ?? false,
            pedWaitsOn: msg.pedWaitsOn ?? false,
            riskCrashes: msg.riskCrashes ?? 0,
            pedWait: msg.pedWait ?? DEFAULT_METRICS.pedWait,
            closedEdges: msg.closedEdges ?? [],
            meters: stats.meters ?? [],
            replayLive: msg.runId !== undefined && msg.runId > replayFloorRef.current,
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

  // In free play the optional rules follow the switches, live.
  const freeElastic = useEditorStore((s) => s.elasticDemand);
  const freeRisk = useEditorStore((s) => s.crashRisk);
  const freeWaits = useEditorStore((s) => s.pedWaits);
  const inFreePlay = useEditorStore((s) => s.activeScenarioId === null);
  useEffect(() => {
    if (!inFreePlay) return;
    workerRef.current?.postMessage({ type: "setElasticDemand", enabled: freeElastic } satisfies WorkerInMessage);
    workerRef.current?.postMessage({ type: "setCrashRisk", enabled: freeRisk } satisfies WorkerInMessage);
    workerRef.current?.postMessage({ type: "setPedWaits", enabled: freeWaits } satisfies WorkerInMessage);
  }, [inFreePlay, freeElastic, freeRisk, freeWaits]);

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
    if (mode !== "simulate" || replaying) return;
    const worker = workerRef.current;
    if (!worker) return;
    const snapshot = useEditorStore.getState().getSnapshot();
    // Every time traffic opens (or a level restarts) is a fresh run from t = 0, so the fixed seed really does
    // replay the same traffic and a fix can be judged against the last attempt.
    worker.postMessage({ type: "reset" } satisfies WorkerInMessage);
    worker.postMessage({ type: "updateNetwork", network: snapshot, seed: DEFAULT_SEED } satisfies WorkerInMessage);
    postScenarioEvents(worker);
    postRunFlags(worker);

    const edgeSig = (e: EdgeSpec) => `${e.speedLimitMph}|${JSON.stringify(e.laneMoves ?? null)}|${e.reservedLane ?? ""}|${(e.bannedTurns ?? []).join(".")}|${e.meterS ?? 0}|${e.meterAuto ? 1 : 0}|${e.crosswalk ? 1 : 0}|${e.busStop ? 1 : 0}|${e.parking ? 1 : 0}|${e.vslMph ?? ""}|${(e.closedLanes ?? []).join(".")}|${e.displacedLeft ? 1 : 0}`;
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
          bannedTurns: e.bannedTurns ?? [],
          meterS: e.meterS ?? 0,
          meterAuto: e.meterAuto ?? false,
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
  }, [mode, simEpoch, replaying]);

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

  /** The player takes the wheel of the vehicle with this id (from the snapshot). */
  const takeWheel = useCallback((id: number) => {
    workerRef.current?.postMessage({ type: "drive", action: "take", id } satisfies WorkerInMessage);
  }, []);

  const releaseWheel = useCallback(() => {
    workerRef.current?.postMessage({ type: "drive", action: "release", id: 0 } satisfies WorkerInMessage);
  }, []);

  /** Pedals (accel -1 brake, 0 coast, 1 throttle) and lane-change requests (-1 left, 1 right) while driving. */
  const driveInput = useCallback((input: { accel?: -1 | 0 | 1; lane?: -1 | 0 | 1 }) => {
    workerRef.current?.postMessage({ type: "driveInput", ...input } satisfies WorkerInMessage);
  }, []);

  const clearDriveResult = useCallback(() => setDriveResult(null), []);

  /** The moments of this run worth jumping to, in time order (with the worst jam added). */
  const getHighlights = useCallback((): Highlight[] => {
    const { list, jam } = highlightsRef.current;
    const all = [...list];
    if (jam.n >= 3) all.push({ at: Math.round(jam.at * 10) / 10, kind: "jam", label: `Worst jam: ${jam.n} roads at once` });
    return all.sort((a, b) => a.at - b.at);
  }, []);

  /** The actions that have shaped the current run so far: everything needed to play it back. */
  const getRecording = useCallback((): LoggedAction[] => recordingRef.current.actions.slice(), []);

  /** Ends a replay: the worker goes back to taking live edits, with the settings (weather, light, bus lines, mix, car cap) the editor holds now. Call after the editor has put its own city back. */
  const endReplay = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const st = useEditorStore.getState();
    replayFloorRef.current = Infinity;
    worker.postMessage({ type: "reset" } satisfies WorkerInMessage);
    worker.postMessage({ type: "setWeather", weather: st.weather } satisfies WorkerInMessage);
    worker.postMessage({ type: "setDarkness", level: st.timeOfDay === "night" ? 1 : st.timeOfDay === "dusk" ? 0.5 : 0 } satisfies WorkerInMessage);
    worker.postMessage({ type: "setDayCycle", enabled: st.dayCycle, startHour: 6, dayLengthS: 480 } satisfies WorkerInMessage);
    worker.postMessage({ type: "setTransit", lines: st.transitLines } satisfies WorkerInMessage);
    worker.postMessage({ type: "setTrafficMix", bus: st.trafficMix.bus, bike: st.trafficMix.bike } satisfies WorkerInMessage);
    worker.postMessage({ type: "setMaxVehicles", value: graphics.vehicleCap } satisfies WorkerInMessage);
    worker.postMessage({ type: "setRunning", running: false } satisfies WorkerInMessage);
  }, [graphics.vehicleCap]);

  /** Plays a recorded run back from the start, exactly as it happened. The roads shown must already be the replay's. */
  const playReplay = useCallback((actions: LoggedAction[]) => {
    const worker = workerRef.current;
    if (!worker) return;
    replayFloorRef.current = recordingRef.current.runId;
    worker.postMessage({ type: "reset" } satisfies WorkerInMessage);
    worker.postMessage({ type: "replay", actions } satisfies WorkerInMessage);
    setUserPaused(false);
    worker.postMessage({ type: "setRunning", running: true } satisfies WorkerInMessage);
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
    takeWheel,
    releaseWheel,
    driveInput,
    driveResult,
    clearDriveResult,
    getRecording,
    getHighlights,
    playReplay,
    endReplay,
  };
}

export type UseTrafficSimulationReturn = ReturnType<
  typeof useTrafficSimulation
>;
