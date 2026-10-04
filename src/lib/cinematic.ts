"use client";

import { useSyncExternalStore } from "react";

/** The drone flyover that plays after a win: what it's celebrating, so its overlay can name it and share the result. */

export interface FlyoverInfo {
  name: string;
  stars: number;
  /** A one-line result for the share text. */
  summary: string;
  /** Builds the "beat my score" link for this level or city, or null when the result carries no score. */
  makeLink: (() => Promise<string>) | null;
}

let current: FlyoverInfo | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function startFlyover(info: FlyoverInfo): void {
  current = info;
  emit();
}

export function stopFlyover(): void {
  if (!current) return;
  current = null;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useFlyover(): FlyoverInfo | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
}

// Dev builds only: `__flyover({ name: "Test", stars: 3, summary: "", makeLink: null })` starts a flyover from the console.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __flyover: typeof startFlyover }).__flyover = startFlyover;
}
