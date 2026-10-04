"use client";

import { useSyncExternalStore } from "react";

/**
 * The red warning banner for trouble that is about to arrive ("ESTADIO BBVA MATCH ENDS - 250 VEHICLES INBOUND"): its
 * text and how many seconds remain until it hits. Callers keep the countdown current from the simulation's clock, so it
 * stays right at any playback speed, and clear it (or let it run to zero) when the trouble arrives.
 */
export interface Panic {
  id: string;
  text: string;
  secondsLeft: number;
}

let current: Panic | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Shows or updates the banner. A new `id` is a new alert (and sounds the siren once); the same id just moves the countdown. */
export function setPanic(next: Panic | null): void {
  if (next === null && current === null) return;
  if (next && current && next.id === current.id && next.text === current.text && Math.ceil(next.secondsLeft) === Math.ceil(current.secondsLeft)) return;
  current = next;
  emit();
}

export function clearPanic(id?: string): void {
  if (current && (id === undefined || current.id === id)) {
    current = null;
    emit();
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function usePanic(): Panic | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
}
