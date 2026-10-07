"use client";

import { replaceCareer, exportCareer, type CareerState } from "./career";
import { exportProgress, mergeProgress } from "./progress";
import { importSlot, listSlots, loadSlot, type SlotMeta } from "./saveSlots";
import type { PersistedPayload } from "@/state/persistence";

/**
 * Backing up saves, stars and the career to the server and getting them back on another device, with no account: a
 * sync code made on this device is the key (see src/app/api/sync/route.ts).
 */

const CODE_KEY = "road-constructor:sync-code:v1";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSyncCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => ALPHABET[b % 32]).join("");
}

export function loadSyncCode(): string {
  try {
    return window.localStorage.getItem(CODE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveSyncCode(code: string): void {
  try {
    window.localStorage.setItem(CODE_KEY, code);
  } catch {
    // private mode: the code just isn't remembered on this device
  }
}

/** "ABCD-EFGH-IJKL-MNOP" for reading out; the other way round for typing in. */
export function formatSyncCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

export function parseSyncCode(text: string): string | null {
  const code = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  return /^[A-Z2-7]{16}$/.test(code) ? code : null;
}

interface Backup {
  v: 1;
  slots: { meta: SlotMeta; payload: PersistedPayload }[];
  career: CareerState;
  progress: Record<string, number>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pack(backup: Backup): Promise<string> {
  const stream = new Blob([JSON.stringify(backup)]).stream().pipeThrough(new CompressionStream("gzip"));
  return bytesToBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function unpack(blob: string): Promise<Backup | null> {
  try {
    const stream = new Blob([base64ToBytes(blob) as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    const raw = JSON.parse(await new Response(stream).text()) as Partial<Backup>;
    if (raw.v !== 1 || !Array.isArray(raw.slots) || !raw.career || !raw.progress) return null;
    return raw as Backup;
  } catch {
    return null;
  }
}

async function post(body: unknown): Promise<{ ok: true; data: { blob?: string; at?: number } } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    const data = (await res.json()) as { error?: string; blob?: string; at?: number };
    return res.ok ? { ok: true, data } : { ok: false, error: data.error ?? "The backup service isn't available" };
  } catch {
    return { ok: false, error: "Couldn't reach the backup service" };
  }
}

export async function syncEnabled(): Promise<boolean> {
  try {
    const res = await fetch("/api/sync", { cache: "no-store" });
    return res.ok && !!((await res.json()) as { enabled?: boolean }).enabled;
  } catch {
    return false;
  }
}

/** Uploads every save, the stars and the career. */
export async function backUp(code: string): Promise<{ ok: true; slots: number; at: number } | { ok: false; error: string }> {
  const metas = await listSlots();
  const slots: Backup["slots"] = [];
  for (const m of metas) {
    const full = await loadSlot(m.id);
    if (full) slots.push(full);
  }
  const blob = await pack({ v: 1, slots, career: exportCareer(), progress: exportProgress() });
  const r = await post({ action: "put", code, blob });
  return r.ok ? { ok: true, slots: slots.length, at: r.data.at ?? Date.now() } : r;
}

/** Downloads a backup and merges it in: saves are added, stars keep the better rating, and the career keeps whichever has earned more (with the medals of both). */
export async function restore(code: string): Promise<{ ok: true; slots: number } | { ok: false; error: string }> {
  const r = await post({ action: "get", code });
  if (!r.ok) return r;
  const backup = r.data.blob ? await unpack(r.data.blob) : null;
  if (!backup) return { ok: false, error: "That backup is damaged" };
  for (const s of backup.slots) await importSlot(s.meta, s.payload);
  mergeProgress(backup.progress);
  const local = exportCareer();
  const medals: CareerState["medals"] = { ...local.medals };
  for (const [id, list] of Object.entries(backup.career.medals ?? {})) medals[id] = Array.from(new Set([...(medals[id] ?? []), ...list]));
  const better = backup.career.earned > local.earned ? backup.career : local;
  replaceCareer({ funds: better.funds, earned: better.earned, runs: Math.max(local.runs, backup.career.runs ?? 0), medals });
  return { ok: true, slots: backup.slots.length };
}
