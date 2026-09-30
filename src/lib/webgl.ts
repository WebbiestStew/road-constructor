"use client";

import { useSyncExternalStore } from "react";

let cached: boolean | null = null;

export function detectWebGL(): boolean {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement("canvas");
    cached = !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    cached = false;
  }
  return cached;
}

const noopSubscribe = () => () => {};

/** False only when we've positively detected no WebGL; true during SSR so hydration matches. */
export function useWebGLSupported(): boolean {
  return useSyncExternalStore(noopSubscribe, detectWebGL, () => true);
}
