"use client";

import { useSyncExternalStore } from "react";

/**
 * Accessibility and comfort preferences, kept in this browser. They start from what the operating system says
 * (reduced motion) and the player can override them in the settings menu.
 */
export interface Prefs {
  /** Stop decorative motion: rain streaks, confetti, roads rising into place, the photo-mode orbit, pulsing markers. */
  reducedMotion: boolean;
  /** Scale the whole interface up about 12%. */
  largeText: boolean;
  /** Draw jam and incident markers larger, with a heavier outline, so they read without relying on colour. */
  boldMarkers: boolean;
}

const KEY = "road-constructor:prefs:v1";
const DEFAULTS: Prefs = { reducedMotion: false, largeText: false, boldMarkers: false };

let prefs: Prefs = DEFAULTS;
let hydrated = false;
const listeners = new Set<() => void>();

function apply() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (prefs.reducedMotion) root.setAttribute("data-reduced-motion", "");
  else root.removeAttribute("data-reduced-motion");
  root.style.fontSize = prefs.largeText ? "112.5%" : "";
  if (prefs.boldMarkers) root.setAttribute("data-bold-markers", "");
  else root.removeAttribute("data-bold-markers");
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  let next: Prefs = { ...DEFAULTS, reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      next = {
        reducedMotion: typeof p.reducedMotion === "boolean" ? p.reducedMotion : next.reducedMotion,
        largeText: p.largeText === true,
        boldMarkers: p.boldMarkers === true,
      };
    }
  } catch {
    // unreadable: keep the defaults
  }
  prefs = next;
  apply();
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  hydrate();
  prefs = { ...prefs, [key]: value };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
  apply();
  listeners.forEach((l) => l());
}

export function getPrefs(): Prefs {
  hydrate();
  return prefs;
}

function subscribe(cb: () => void) {
  hydrate();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    subscribe,
    () => getPrefs(),
    () => DEFAULTS
  );
}

export function useReducedMotion(): boolean {
  return usePrefs().reducedMotion;
}
