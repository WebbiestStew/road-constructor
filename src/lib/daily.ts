"use client";

import { useSyncExternalStore } from "react";

/** Daily-challenge bookkeeping: today's date key, your best score per day, and your streak. All in this browser. */

const KEY = "road-constructor:daily:v1";

/** Local-calendar date as YYYY-MM-DD: the daily challenge rolls over at the player's own midnight. */
export function dateKey(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

let cache: Record<string, number> | null = null;
const listeners = new Set<() => void>();

function read(): Record<string, number> {
  if (cache) return cache;
  cache = {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) cache[k] = v;
      }
    }
  } catch {
    // unreadable: start fresh
  }
  return cache;
}

/** Keeps the best score for that day. Returns true if it's a new best for the day. */
export function recordDaily(key: string, trips: number): boolean {
  const map = read();
  if (trips <= (map[key] ?? 0)) return false;
  cache = { ...map, [key]: trips };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
  return true;
}

/** Consecutive days with a finished daily, counting back from today (or from yesterday if today isn't done yet). */
export function streakFrom(map: Record<string, number>, today: string): number {
  const d = new Date(`${today}T12:00:00`);
  if (!map[dateKey(d)]) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (map[dateKey(d)]) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: Record<string, number> = {};

export function useDaily(): { today: string; bestToday: number; streak: number } {
  const map = useSyncExternalStore(subscribe, read, () => EMPTY);
  const today = dateKey();
  return { today, bestToday: map[today] ?? 0, streak: streakFrom(map, today) };
}
