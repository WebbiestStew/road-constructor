import type { NetworkSnapshot } from "@/sim/types";

const STORAGE_KEY = "road-constructor:autosave:v1";
const CORRUPT_BACKUP_KEY = "road-constructor:autosave:corrupt";

/** Bump when the saved shape changes, and add a migration step in `migrate`. */
export const CURRENT_SAVE_VERSION = 2;

export interface PersistedPayload {
  app: "road-constructor";
  version: typeof CURRENT_SAVE_VERSION;
  network: NetworkSnapshot;
  budget: number;
  nextNodeSeq: number;
  nextEdgeSeq: number;
}

function isPoint3(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function isNetworkSnapshot(value: unknown): value is NetworkSnapshot {
  if (!value || typeof value !== "object") return false;
  const { nodes, edges } = value as Record<string, unknown>;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false;

  const nodeIds = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n !== "object") return false;
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string" || !isPoint3(node.position)) return false;
    nodeIds.add(node.id);
  }
  for (const e of edges) {
    if (!e || typeof e !== "object") return false;
    const edge = e as Record<string, unknown>;
    if (typeof edge.id !== "string") return false;
    if (typeof edge.fromNodeId !== "string" || !nodeIds.has(edge.fromNodeId)) return false;
    if (typeof edge.toNodeId !== "string" || !nodeIds.has(edge.toNodeId)) return false;
    if (!Array.isArray(edge.interiorPoints) || !edge.interiorPoints.every(isPoint3)) return false;
    if (typeof edge.roadClassId !== "string" || typeof edge.elevationLevelId !== "string") return false;
    for (const k of ["lanes", "laneWidthFt", "speedLimitMph"] as const) {
      if (typeof edge[k] !== "number" || !Number.isFinite(edge[k])) return false;
    }
    if (edge.laneMoves !== undefined) {
      const ok =
        Array.isArray(edge.laneMoves) &&
        edge.laneMoves.every(
          (lane) => Array.isArray(lane) && lane.every((m) => m === "left" || m === "straight" || m === "right")
        );
      if (!ok) return false;
    }
  }
  return true;
}

/** Upgrades any known older save to the current shape; returns null if unrecognised or from a newer build. */
function migrate(value: unknown): PersistedPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number" || v.version < 1 || v.version > CURRENT_SAVE_VERSION) return null;
  if (
    !isNetworkSnapshot(v.network) ||
    typeof v.budget !== "number" ||
    !Number.isFinite(v.budget) ||
    typeof v.nextNodeSeq !== "number" ||
    typeof v.nextEdgeSeq !== "number"
  ) {
    return null;
  }
  // v1 -> v2: identical data, v2 only adds the `app` tag.
  return {
    app: "road-constructor",
    version: CURRENT_SAVE_VERSION,
    network: v.network,
    budget: v.budget,
    nextNodeSeq: v.nextNodeSeq,
    nextEdgeSeq: v.nextEdgeSeq,
  };
}

export function loadAutosave(): PersistedPayload | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const payload = migrate(JSON.parse(raw));
    if (payload) return payload;
  } catch {
    // fall through to the backup path below
  }
  // Unreadable or from a newer build: keep the raw text so it isn't lost when the next autosave overwrites it.
  try {
    if (raw) window.localStorage.setItem(CORRUPT_BACKUP_KEY, raw);
  } catch {
    // ignore
  }
  return null;
}

export function saveAutosave(payload: PersistedPayload): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full or unavailable (e.g. private browsing) — silently skip, nothing user-visible to fix.
  }
}

export function clearAutosave(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function downloadNetworkFile(payload: PersistedPayload): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `road-constructor-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function parseNetworkFile(text: string): PersistedPayload | null {
  try {
    return migrate(JSON.parse(text));
  } catch {
    return null;
  }
}
