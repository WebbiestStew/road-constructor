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

// ---------------------------------------------------------------------------
// URL share/permalink: the same PersistedPayload, gzip-compressed and
// base64url-encoded into a `#data=...` URL hash fragment so a whole network
// can be shared as a link with no server-side storage.
// ---------------------------------------------------------------------------

async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Serializes a network payload into a compact, URL-hash-safe string. */
export async function encodePayloadToShareHash(payload: PersistedPayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = await gzipCompress(bytes);
  return bytesToBase64Url(compressed);
}

/** Reverses `encodePayloadToShareHash`, returning null for anything malformed or corrupted. */
export async function decodeShareHash(hash: string): Promise<PersistedPayload | null> {
  try {
    const bytes = base64UrlToBytes(hash);
    const decompressed = await gzipDecompress(bytes);
    const parsed = JSON.parse(new TextDecoder().decode(decompressed));
    return isValidPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
