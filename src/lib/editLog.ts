"use client";

import { useSyncExternalStore } from "react";

/** A running log of the player's traffic tweaks and what each one did to average speed. */

export interface EditEntry {
  id: number;
  label: string;
  /** Change in average speed (mph) once the edit had time to play out; null while still measuring. */
  delta: number | null;
}

const MAX_ENTRIES = 8;

let entries: EditEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  entries = [...entries]; // new reference so subscribers re-render
  listeners.forEach((l) => l());
}

export function startEdit(label: string): number {
  const id = nextId++;
  entries = [{ id, label, delta: null }, ...entries].slice(0, MAX_ENTRIES);
  emit();
  return id;
}

export function relabelEdit(id: number, label: string): void {
  const e = entries.find((x) => x.id === id);
  if (!e || e.label === label) return;
  e.label = label;
  emit();
}

export function finishEdit(id: number, delta: number): void {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.delta = delta;
  emit();
}

export function clearEdits(): void {
  entries = [];
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: EditEntry[] = [];

export function useEditLog(): EditEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => entries,
    () => EMPTY
  );
}
