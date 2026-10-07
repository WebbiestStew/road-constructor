"use client";

import { idbAll, idbDelete, idbGet, idbPut } from "./idb";
import { isValidNetwork } from "@/state/persistence";
import type { EdgePatch, EdgeSpec, JunctionControl, LoggedAction, NetworkSnapshot, NodeSpec, TransitLine, Weather, WorkerInMessage } from "@/sim/types";

/**
 * Run replays. The sim is deterministic, so a run is kept as the list of player actions that shaped it (each stamped
 * with the sim time it was applied at), and played back by feeding them to a fresh run: exactly the same traffic, with
 * no per-vehicle data kept. A replay is small (a few KB plus the roads) and can be sent as a file.
 */

export const MAX_REPLAYS = 12;
const MAX_ACTIONS = 20000;

export interface ReplayMeta {
  id: string;
  name: string;
  savedAt: number;
  /** The level it was played on (null for free build, a place, or a friend's city), to bring its scenery back. */
  scenarioId: string | null;
  scenarioName: string;
  durationS: number;
  stars: number;
  score: number | null;
  summary: string;
  actionCount: number;
}

export interface ReplayRecord extends ReplayMeta {
  actions: LoggedAction[];
}

interface ReplayData {
  id: string;
  actions: LoggedAction[];
}

export async function listReplays(): Promise<ReplayMeta[]> {
  const all = await idbAll<ReplayMeta>("replayMeta");
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveReplay(input: Omit<ReplayMeta, "id" | "savedAt" | "actionCount"> & { actions: LoggedAction[] }): Promise<ReplayMeta> {
  const id = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const { actions, ...rest } = input;
  const meta: ReplayMeta = { ...rest, name: rest.name.trim().slice(0, 60) || "A run", id, savedAt: Date.now(), actionCount: actions.length };
  await idbPut<ReplayData>("replayData", { id, actions });
  await idbPut("replayMeta", meta);
  // keep the newest few
  const all = await listReplays();
  for (const old of all.slice(MAX_REPLAYS)) await deleteReplay(old.id);
  return meta;
}

export async function loadReplay(id: string): Promise<ReplayRecord | null> {
  const [meta, data] = await Promise.all([idbGet<ReplayMeta>("replayMeta", id), idbGet<ReplayData>("replayData", id)]);
  return meta && data ? { ...meta, actions: data.actions } : null;
}

export async function renameReplay(id: string, name: string): Promise<void> {
  const meta = await idbGet<ReplayMeta>("replayMeta", id);
  if (meta) await idbPut("replayMeta", { ...meta, name: name.trim().slice(0, 60) || meta.name });
}

export async function deleteReplay(id: string): Promise<void> {
  await Promise.all([idbDelete("replayMeta", id), idbDelete("replayData", id)]);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const FILE_KIND = "road-constructor-replay";

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Downloads a replay as a compressed file that can be sent to a friend. */
export async function downloadReplayFile(record: ReplayRecord): Promise<void> {
  const { actions, ...meta } = record;
  const blob = await gzip(JSON.stringify({ kind: FILE_KIND, v: 1, meta, actions }));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `road-constructor-replay-${meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run"}.rcreplay`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const ALLOWED_ACTION_TYPES = new Set<WorkerInMessage["type"]>([
  "updateNetwork",
  "patchEdges",
  "patchNodes",
  "setDemand",
  "breakdown",
  "ambulance",
  "crash",
  "incident",
  "dispatchWrecker",
  "setTransit",
  "setWeather",
  "setDarkness",
  "setTrafficMix",
  "setLeftTurnsYield",
  "setRageWeaves",
  "scheduleEvents",
  "setDayCycle",
  "setMaxVehicles",
  "drive",
  "driveInput",
]);

/** Vets a replay that came from a file (or anywhere outside this session): known action types, sane times, and roads that pass the same check as a shared city. Null if anything is off. */
export function validateReplay(raw: unknown): ReplayRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { kind?: unknown; meta?: Partial<ReplayMeta>; actions?: unknown };
  if (r.kind !== FILE_KIND || !r.meta || !Array.isArray(r.actions) || r.actions.length === 0 || r.actions.length > MAX_ACTIONS) return null;
  let last = 0;
  let sawNetwork = false;
  for (const a of r.actions as LoggedAction[]) {
    if (!a || typeof a.at !== "number" || !Number.isFinite(a.at) || a.at < 0 || !a.msg || !ALLOWED_ACTION_TYPES.has(a.msg.type)) return null;
    if (a.msg.type === "updateNetwork") {
      if (!isValidNetwork(a.msg.network) || typeof a.msg.seed !== "number") return null;
      sawNetwork = true;
    }
    last = Math.max(last, a.at);
  }
  if (!sawNetwork) return null;
  const m = r.meta;
  return {
    id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: String(m.name ?? "A friend's run").slice(0, 60),
    savedAt: Date.now(),
    scenarioId: typeof m.scenarioId === "string" ? m.scenarioId.slice(0, 80) : null,
    scenarioName: String(m.scenarioName ?? "A run").slice(0, 60),
    durationS: Number.isFinite(m.durationS) ? Math.min(3600, Math.max(10, m.durationS as number)) : Math.max(60, Math.ceil(last)),
    stars: Number.isFinite(m.stars) ? Math.min(3, Math.max(0, m.stars as number)) : 0,
    score: Number.isFinite(m.score) ? (m.score as number) : null,
    summary: String(m.summary ?? "").slice(0, 200),
    actionCount: r.actions.length,
    actions: r.actions as LoggedAction[],
  };
}

export async function parseReplayFile(file: File): Promise<ReplayRecord | null> {
  try {
    let text: string;
    try {
      text = await gunzip(file);
    } catch {
      text = await file.text(); // an uncompressed file works too
    }
    return validateReplay(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading a script
// ---------------------------------------------------------------------------

export interface ReplayStart {
  network: NetworkSnapshot;
  transit: TransitLine[];
  weather: Weather;
  darkness: number;
  dayCycle: boolean;
  trafficMix: { bus: number; bike: number };
}

/** The state a run began in, read from its first actions: the roads, bus lines, weather, light and traffic mix. */
export function replayStart(actions: LoggedAction[]): ReplayStart | null {
  let network: NetworkSnapshot | null = null;
  const start: Omit<ReplayStart, "network"> = { transit: [], weather: "clear", darkness: 0, dayCycle: false, trafficMix: { bus: 0, bike: 0 } };
  for (const a of actions) {
    if (a.at > 0) break;
    const m = a.msg;
    if (m.type === "updateNetwork") network = m.network;
    else if (m.type === "setTransit") start.transit = m.lines;
    else if (m.type === "setWeather") start.weather = m.weather;
    else if (m.type === "setDarkness") start.darkness = m.level;
    else if (m.type === "setDayCycle") start.dayCycle = m.enabled;
    else if (m.type === "setTrafficMix") start.trafficMix = { bus: m.bus, bike: m.bike };
  }
  return network ? { network, ...start } : null;
}

/** The player's tweaks to roads and signals during the run, in time order, for showing them on the map as the replay reaches them. */
export function visualPatches(actions: LoggedAction[]): LoggedAction[] {
  return actions.filter((a) => a.at > 0 && (a.msg.type === "patchEdges" || a.msg.type === "patchNodes"));
}

function patchedEdge(e: EdgeSpec, p: EdgePatch): EdgeSpec {
  const next: EdgeSpec = { ...e, speedLimitMph: p.speedLimitMph };
  const set = <K extends keyof EdgeSpec>(key: K, value: EdgeSpec[K] | null | undefined) => {
    if (value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0)) delete next[key];
    else next[key] = value;
  };
  set("laneMoves", p.laneMoves);
  if (p.reservedLane !== undefined) set("reservedLane", p.reservedLane);
  if (p.bannedTurns !== undefined) set("bannedTurns", p.bannedTurns as ("left" | "right")[]);
  if (p.crosswalk !== undefined) set("crosswalk", p.crosswalk);
  if (p.busStop !== undefined) set("busStop", p.busStop);
  if (p.parking !== undefined) set("parking", p.parking);
  if (p.vslMph !== undefined) set("vslMph", p.vslMph);
  if (p.closedLanes !== undefined) set("closedLanes", p.closedLanes);
  if (p.displacedLeft !== undefined) set("displacedLeft", p.displacedLeft);
  return next;
}

/** Applies logged edge and signal patches to the roads shown on the map. */
export function applyPatchActions(nodes: NodeSpec[], edges: EdgeSpec[], actions: LoggedAction[]): { nodes: NodeSpec[]; edges: EdgeSpec[] } {
  let outEdges = edges;
  let outNodes = nodes;
  for (const a of actions) {
    if (a.msg.type === "patchEdges") {
      const byId = new Map(a.msg.edges.map((p) => [p.id, p]));
      outEdges = outEdges.map((e) => (byId.has(e.id) ? patchedEdge(e, byId.get(e.id)!) : e));
    } else if (a.msg.type === "patchNodes") {
      const byId = new Map<string, JunctionControl | null>(a.msg.nodes.map((p) => [p.id, p.control]));
      outNodes = outNodes.map((n) => {
        if (!byId.has(n.id)) return n;
        const control = byId.get(n.id);
        const next = { ...n };
        if (control) next.control = control;
        else delete next.control;
        return next;
      });
    }
  }
  return { nodes: outNodes, edges: outEdges };
}
