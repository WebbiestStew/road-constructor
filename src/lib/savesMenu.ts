"use client";

import { useSyncExternalStore } from "react";

/** Whether the Saves & replays menu is open, and which tab. A tiny store so any button can open it. */
type Tab = "saves" | "replays" | "cloud";
let state: { open: boolean; tab: Tab } = { open: false, tab: "saves" };
const listeners = new Set<() => void>();

export function openSaves(tab: Tab = "saves"): void {
  state = { open: true, tab };
  listeners.forEach((l) => l());
}

export function closeSaves(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  listeners.forEach((l) => l());
}

export function setSavesTab(tab: Tab): void {
  state = { ...state, tab };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useSavesMenu(): { open: boolean; tab: Tab } {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => ({ open: false, tab: "saves" as Tab })
  );
}
