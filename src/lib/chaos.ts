"use client";

import { useSyncExternalStore } from "react";

/** Whether Chaos mode (random breakdowns and rush hours) is switched on. Off by default; remembered per browser. */

const KEY = "road-constructor:chaos:v1";

let enabled: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  if (enabled !== null) return enabled;
  try {
    enabled = window.localStorage.getItem(KEY) === "1";
  } catch {
    enabled = false;
  }
  return enabled;
}

export function setChaos(value: boolean): void {
  enabled = value;
  try {
    window.localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useChaos(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
