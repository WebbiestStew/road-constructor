"use client";

import { useSyncExternalStore } from "react";

/** Phones and small tablets in portrait: below Tailwind's `md` breakpoint. The HUD swaps to its compact layout here. */
const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function useCompact(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  );
}

/** A touch screen as the main pointer: the driving controls grow on-screen buttons here, since there is no keyboard. */
const COARSE_QUERY = "(pointer: coarse)";

function subscribeCoarse(onChange: () => void): () => void {
  const mq = window.matchMedia(COARSE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia(COARSE_QUERY).matches,
    () => false
  );
}
