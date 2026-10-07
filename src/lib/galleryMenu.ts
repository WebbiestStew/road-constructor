"use client";

import { useSyncExternalStore } from "react";

/** Whether the community gallery is open. A tiny store so any button can open it. */
let open = false;
const listeners = new Set<() => void>();

export function setGalleryOpen(value: boolean): void {
  if (open === value) return;
  open = value;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useGalleryOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false
  );
}
