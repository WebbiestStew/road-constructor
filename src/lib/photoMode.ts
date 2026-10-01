"use client";

import { useSyncExternalStore } from "react";

/** Photo mode: the HUD hides, the camera drifts in a slow orbit, and the current frame can be saved as a PNG. */

let enabled = false;
let capture: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function setPhotoMode(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  emit();
}

export function togglePhotoMode(): void {
  setPhotoMode(!enabled);
}

/** The 3D scene registers how to render a fresh frame and download it; the overlay's button calls this. */
export function registerCapture(fn: (() => void) | null): void {
  capture = fn;
}

export function takePhoto(): void {
  capture?.();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function usePhotoMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => false
  );
}
