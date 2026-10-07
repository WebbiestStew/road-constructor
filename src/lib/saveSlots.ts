"use client";

import { idbAll, idbDelete, idbGet, idbPut } from "./idb";
import type { PersistedPayload } from "@/state/persistence";

/**
 * Named save slots, beside the single autosave: a city (roads, budget, bus lines) kept under a name, with the level it
 * belonged to so loading it brings that level's rules back. Kept in IndexedDB; the list reads only the small
 * records, never the roads.
 */

export const MAX_SLOTS = 8;

export interface SlotMeta {
  id: string;
  name: string;
  savedAt: number;
  scenarioId: string | null;
  scenarioName: string | null;
  roads: number;
  budget: number;
  /** For a place loaded from the map: its name. */
  placeName: string | null;
}

interface SlotData {
  id: string;
  payload: PersistedPayload;
}

export async function listSlots(): Promise<SlotMeta[]> {
  const all = await idbAll<SlotMeta>("slotMeta");
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveSlot(
  name: string,
  payload: PersistedPayload,
  context: { scenarioId: string | null; scenarioName: string | null; placeName: string | null },
  replaceId?: string
): Promise<SlotMeta> {
  const existing = await listSlots();
  if (!replaceId && existing.length >= MAX_SLOTS) throw new Error(`All ${MAX_SLOTS} slots are in use: delete one or overwrite it`);
  const id = replaceId ?? `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const meta: SlotMeta = {
    id,
    name: name.trim().slice(0, 40) || "My city",
    savedAt: Date.now(),
    scenarioId: context.scenarioId,
    scenarioName: context.scenarioName,
    roads: payload.network.edges.length,
    budget: payload.budget,
    placeName: context.placeName,
  };
  await idbPut<SlotData>("slotData", { id, payload });
  await idbPut("slotMeta", meta);
  return meta;
}

export async function loadSlot(id: string): Promise<{ meta: SlotMeta; payload: PersistedPayload } | null> {
  const [meta, data] = await Promise.all([idbGet<SlotMeta>("slotMeta", id), idbGet<SlotData>("slotData", id)]);
  return meta && data ? { meta, payload: data.payload } : null;
}

export async function renameSlot(id: string, name: string): Promise<void> {
  const meta = await idbGet<SlotMeta>("slotMeta", id);
  if (!meta) return;
  await idbPut("slotMeta", { ...meta, name: name.trim().slice(0, 40) || meta.name });
}

export async function deleteSlot(id: string): Promise<void> {
  await Promise.all([idbDelete("slotMeta", id), idbDelete("slotData", id)]);
}
