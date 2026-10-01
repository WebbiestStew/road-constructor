"use client";

import { useSyncExternalStore } from "react";
import { playFailTone, playSuccessChime } from "./sound";

/** A tiny global toast channel: anything can `pushToast`, one <ToastHost /> renders the latest. */

export type ToastTone = "good" | "bad" | "info" | "alert";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

const TOAST_MS = 5200;

let current: Toast | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function pushToast(text: string, tone: ToastTone = "info"): void {
  // A little sound makes good and bad news land even if you were looking elsewhere (respects the mute button).
  if (tone === "good") playSuccessChime();
  else if (tone === "bad") playFailTone();
  current = { id: nextId++, text, tone };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, TOAST_MS);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
}
