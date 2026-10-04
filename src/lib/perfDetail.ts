"use client";

import { useSyncExternalStore } from "react";

/**
 * How much optional detail to shed to keep the frame rate up, finer-grained than the quality tiers: 0 = everything on,
 * 1 = the heavy overlays run at a lower rate, 2 = they are switched off. PerfGuard raises it when frames run slow and
 * lowers it again once they have been smooth for a while.
 */
let level: 0 | 1 | 2 = 0;
const listeners = new Set<() => void>();

export function getDetailShed(): 0 | 1 | 2 {
  return level;
}

export function setDetailShed(next: 0 | 1 | 2): void {
  if (next === level) return;
  level = next;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useDetailShed(): 0 | 1 | 2 {
  return useSyncExternalStore(
    subscribe,
    () => level,
    () => 0
  );
}
