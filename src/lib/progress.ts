"use client";

import { useSyncExternalStore } from "react";

/** Best star rating (1-3) earned on each level, kept in this browser. */

const KEY = "road-constructor:progress:v1";

type StarMap = Record<string, 1 | 2 | 3>;

let cache: StarMap | null = null;
const listeners = new Set<() => void>();

function read(): StarMap {
  if (cache) return cache;
  cache = {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [id, v] of Object.entries(parsed)) {
        if (v === 1 || v === 2 || v === 3) cache[id] = v;
      }
    }
  } catch {
    // unreadable or unavailable: start fresh
  }
  return cache;
}

/** Records a win; keeps the best. Returns true if it beat the previous best (or was the first clear). */
export function recordStars(scenarioId: string, stars: 0 | 1 | 2 | 3): boolean {
  if (stars === 0) return false;
  const map = read();
  const prev = map[scenarioId] ?? 0;
  if (stars <= prev) return false;
  cache = { ...map, [scenarioId]: stars };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // ignore: progress just won't persist
  }
  listeners.forEach((l) => l());
  return true;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: StarMap = {};

export function useProgress(): StarMap {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function totalStars(map: StarMap): number {
  return Object.values(map).reduce<number>((a, b) => a + b, 0);
}
