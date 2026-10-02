"use client";

import { useSyncExternalStore } from "react";

/** Whether the settings menu is open. A tiny store so any button (top bar, start menu, a hotkey) can open it. */
let open = false;
const listeners = new Set<() => void>();

export function setSettingsOpen(value: boolean): void {
  if (open === value) return;
  open = value;
  listeners.forEach((l) => l());
}

export function toggleSettings(): void {
  setSettingsOpen(!open);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useSettingsOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false
  );
}
