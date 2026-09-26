import type { NetworkSnapshot } from "@/sim/types";

const STORAGE_KEY = "road-constructor:autosave:v1";

export interface PersistedPayload {
  version: 1;
  network: NetworkSnapshot;
  budget: number;
  nextNodeSeq: number;
  nextEdgeSeq: number;
}

function isValidPayload(value: unknown): value is PersistedPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.network === "object" &&
    v.network !== null &&
    Array.isArray((v.network as Record<string, unknown>).nodes) &&
    Array.isArray((v.network as Record<string, unknown>).edges) &&
    typeof v.budget === "number" &&
    typeof v.nextNodeSeq === "number" &&
    typeof v.nextEdgeSeq === "number"
  );
}

export function loadAutosave(): PersistedPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
    const parsed = JSON.parse(text);
    return isValidPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
