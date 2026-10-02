"use client";

import { useSyncExternalStore } from "react";

/** Photo mode: the HUD hides, the camera drifts in a slow orbit, and the current frame can be saved as a PNG. */

let enabled = false;
let capture: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

let tour = false;

export function setPhotoMode(value: boolean): void {
  if (enabled === value && (value || !tour)) return;
  enabled = value;
  if (!value) tour = false;
  emit();
}

/** The cinematic tour: photo mode plus a camera that flies between wide shots and low swoops over the roads. */
export function setTour(value: boolean): void {
  if (value) enabled = true;
  tour = value;
  emit();
}

export function toggleTour(): void {
  setTour(!tour);
}

export function usePhotoTour(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => tour,
    () => false
  );
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

/** What the 3D scene can hand back: a fresh still frame, or a short recording of the canvas. */
export interface FrameGrabber {
  frame: () => Promise<Blob | null>;
  clip: (seconds: number) => Promise<{ blob: Blob; ext: string } | null>;
}
let grabber: FrameGrabber | null = null;

export function registerGrabber(g: FrameGrabber | null): void {
  grabber = g;
}

/** A fresh PNG of the 3D view (no HUD), or null if the scene isn't ready or the browser refuses. */
export function grabFrame(): Promise<Blob | null> {
  return grabber ? grabber.frame() : Promise.resolve(null);
}

/** Records the 3D view for a few seconds (photo mode keeps the camera moving), or null if the browser can't record. */
export function recordClip(seconds: number): Promise<{ blob: Blob; ext: string } | null> {
  return grabber ? grabber.clip(seconds) : Promise.resolve(null);
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
