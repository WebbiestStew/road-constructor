"use client";

import { useSyncExternalStore } from "react";

/**
 * Graphics quality. Heat and fan noise on a laptop come from the GPU drawing every frame at full resolution,
 * so each step down trades visual polish for a lot less work:
 *  - high:   full pipeline — shadows, ambient occlusion, bloom, up to 1.5x pixel ratio, 60 fps.
 *  - medium: shadows and tone mapping but no post-processing, 1x pixel ratio, 45 fps.
 *  - low:    no shadows, no antialiasing, 1x pixel ratio, 30 fps, far fewer cars.
 */
export type Quality = "high" | "medium" | "low";

export interface QualitySettings {
  /** Concurrent vehicles the simulation will spawn. */
  vehicleCap: number;
  /** Render frame-rate ceiling (frames are skipped, not just throttled by the display). */
  maxFps: number;
  /** Device-pixel-ratio range handed to the canvas. */
  dpr: [number, number];
  shadows: boolean;
  shadowMapSize: number;
  antialias: boolean;
  /** Ambient occlusion + bloom + vignette via the effect composer. */
  postprocessing: boolean;
  /** Scales decorative scenery counts (trees) on the landing hero. */
  scenery: number;
}

export const QUALITY_SETTINGS: Record<Quality, QualitySettings> = {
  high: { vehicleCap: 1500, maxFps: 60, dpr: [1, 1.5], shadows: true, shadowMapSize: 2048, antialias: true, postprocessing: true, scenery: 1 },
  medium: { vehicleCap: 1000, maxFps: 45, dpr: [1, 1], shadows: true, shadowMapSize: 1024, antialias: true, postprocessing: false, scenery: 0.6 },
  low: { vehicleCap: 500, maxFps: 30, dpr: [1, 1], shadows: false, shadowMapSize: 512, antialias: false, postprocessing: false, scenery: 0.3 },
};

export const VEHICLE_CAP: Record<Quality, number> = {
  high: QUALITY_SETTINGS.high.vehicleCap,
  medium: QUALITY_SETTINGS.medium.vehicleCap,
  low: QUALITY_SETTINGS.low.vehicleCap,
};

const ORDER: Quality[] = ["high", "medium", "low"];
const QUALITY_KEY = "road-constructor:quality:v1";

/** The next tier down (stays at low). */
export function lowerQuality(q: Quality): Quality {
  return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(q) + 1)];
}

/** Cycles high -> medium -> low -> high, for the top-bar button. */
export function nextQuality(q: Quality): Quality {
  return ORDER[(ORDER.indexOf(q) + 1) % ORDER.length];
}

/**
 * Picks a starting tier from what the browser will tell us about the machine. Weak or unknown hardware starts
 * low or medium rather than discovering it the hard way by cooking; a clearly strong machine gets the full look.
 */
function detectDefaultQuality(): Quality {
  if (typeof navigator === "undefined") return "medium";
  const cores = navigator.hardwareConcurrency ?? 4;
  // Safari and Firefox don't report device memory; treat "unknown" as fine rather than as weak.
  const memoryGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  let renderer = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  } catch {
    // masked or unavailable — fall back to the CPU/memory signals
  }
  const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
  const mobileGpu = /mali|adreno|powervr|videocore/i.test(renderer);
  const integratedIntel = /intel/i.test(renderer);
  const discreteOrApple = /apple|nvidia|geforce|radeon rx|radeon pro|rtx|gtx/i.test(renderer);

  if (software || mobileGpu || touch || cores <= 2 || memoryGb <= 2) return "low";
  if (integratedIntel || cores <= 4 || memoryGb <= 4) return "medium";
  if (discreteOrApple && cores >= 8) return "high";
  return "medium";
}

let quality: Quality = "high";
let autoDowngraded = false;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const saved = window.localStorage.getItem(QUALITY_KEY);
    if (saved === "high" || saved === "medium" || saved === "low") {
      quality = saved;
      return;
    }
  } catch {
    // storage unavailable — fall through to detection
  }
  quality = detectDefaultQuality();
}

export function setQuality(value: Quality, auto = false): void {
  hydrate();
  if (value === quality) return;
  const wasLower = ORDER.indexOf(value) > ORDER.indexOf(quality);
  quality = value;
  autoDowngraded = auto && wasLower;
  try {
    window.localStorage.setItem(QUALITY_KEY, value);
  } catch {
    // ignore
  }
  emit();
}

export function dismissAutoNotice(): void {
  if (!autoDowngraded) return;
  autoDowngraded = false;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Quality as read on the server / first client render — keeps hydration stable; the real choice applies right after. */
const SERVER_QUALITY: Quality = "high";

export function useQuality(): Quality {
  return useSyncExternalStore(
    subscribe,
    () => {
      hydrate();
      return quality;
    },
    () => SERVER_QUALITY
  );
}

export function useAutoDowngraded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => autoDowngraded,
    () => false
  );
}

const noopSubscribe = () => () => {};

/** False on the server and during hydration, true on the client afterwards — lets a component hold off mounting anything that depends on client-only state (like the saved quality). */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
