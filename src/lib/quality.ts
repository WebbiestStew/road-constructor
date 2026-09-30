"use client";

import { useSyncExternalStore } from "react";

/**
 * Graphics quality. "low" drops shadows and antialiasing, renders at 1x pixel
 * ratio and caps concurrent vehicles, so weaker laptops stay interactive.
 */
export type Quality = "high" | "low";

const QUALITY_KEY = "road-constructor:quality:v1";

export const VEHICLE_CAP: Record<Quality, number> = { high: 1500, low: 500 };

let quality: Quality = "high";
let autoDowngraded = false;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    if (window.localStorage.getItem(QUALITY_KEY) === "low") quality = "low";
  } catch {
    // storage unavailable — stay on the default
  }
}

export function setQuality(value: Quality, auto = false): void {
  hydrate();
  if (value === quality) return;
  quality = value;
  autoDowngraded = auto && value === "low";
  try {
    window.localStorage.setItem(QUALITY_KEY, value);
  } catch {
    // ignore
  }
  emit();
}

export function dismissAutoNotice(): void {
  if (!autoDowngraded) return;
  autoDowngraded = false;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Quality as read on the server / first client render — keeps hydration stable; the stored choice applies right after. */
const SERVER_QUALITY: Quality = "high";

export function useQuality(): Quality {
  return useSyncExternalStore(
    subscribe,
    () => {
      hydrate();
      return quality;
    },
    () => SERVER_QUALITY
  );
}

export function useAutoDowngraded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => autoDowngraded,
    () => false
  );
}
