"use client";

/** Tracks whether the first-run tutorial has been dismissed, and lets a help button re-open it on demand. */

const SEEN_KEY = "road-constructor:tutorial-seen:v1";

const openListeners = new Set<() => void>();

export function hasSeenTutorial(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markTutorialSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // ignore
  }
}

export function requestOpenTutorial(): void {
  for (const l of openListeners) l();
}

export function subscribeOpenTutorial(listener: () => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}
