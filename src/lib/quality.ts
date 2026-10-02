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
  /** Cars drawn as shaped vehicles (cabin, wheels, lights) rather than plain boxes. */
  detailedVehicles: boolean;
  /** Buildings, water and other set dressing around real cities and the landing hero. */
  setDressing: boolean;
  /** Rain streaks over the screen in wet weather (the tint and fog stay either way). */
  weatherEffects: boolean;
}

/** Everything the player can switch individually in the settings menu. */
export type GraphicsOptionKey = "shadows" | "postprocessing" | "antialias" | "detailedVehicles" | "setDressing" | "weatherEffects" | "maxFps" | "dprMax" | "vehicleCap";

export const QUALITY_SETTINGS: Record<Quality, QualitySettings> = {
  high: { vehicleCap: 1500, maxFps: 60, dpr: [1, 1.5], shadows: true, shadowMapSize: 2048, antialias: true, postprocessing: true, scenery: 1, detailedVehicles: true, setDressing: true, weatherEffects: true },
  medium: { vehicleCap: 1000, maxFps: 45, dpr: [1, 1], shadows: true, shadowMapSize: 1024, antialias: true, postprocessing: false, scenery: 0.6, detailedVehicles: true, setDressing: true, weatherEffects: true },
  low: { vehicleCap: 500, maxFps: 30, dpr: [1, 1], shadows: false, shadowMapSize: 512, antialias: false, postprocessing: false, scenery: 0.3, detailedVehicles: false, setDressing: false, weatherEffects: false },
};

/** The player's individual overrides on top of the chosen preset; only keys they changed are present. */
export interface GraphicsOverrides {
  shadows?: boolean;
  postprocessing?: boolean;
  antialias?: boolean;
  detailedVehicles?: boolean;
  setDressing?: boolean;
  weatherEffects?: boolean;
  maxFps?: number;
  /** Highest pixel ratio the canvas may use. */
  dprMax?: number;
  vehicleCap?: number;
}

/** A preset with the player's overrides applied: what the renderer and the simulation actually use. */
export function resolveSettings(base: Quality, o: GraphicsOverrides): QualitySettings {
  const b = QUALITY_SETTINGS[base];
  const dprMax = o.dprMax ?? b.dpr[1];
  return {
    ...b,
    ...(o.shadows !== undefined ? { shadows: o.shadows } : {}),
    ...(o.postprocessing !== undefined ? { postprocessing: o.postprocessing } : {}),
    ...(o.antialias !== undefined ? { antialias: o.antialias } : {}),
    ...(o.detailedVehicles !== undefined ? { detailedVehicles: o.detailedVehicles } : {}),
    ...(o.setDressing !== undefined ? { setDressing: o.setDressing } : {}),
    ...(o.weatherEffects !== undefined ? { weatherEffects: o.weatherEffects } : {}),
    maxFps: o.maxFps ?? b.maxFps,
    vehicleCap: o.vehicleCap ?? b.vehicleCap,
    dpr: [Math.min(1, dprMax), dprMax],
  };
}

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

const OVERRIDES_KEY = "road-constructor:graphics-overrides:v1";
let overrides: GraphicsOverrides = {};
let resolved: QualitySettings = QUALITY_SETTINGS.high;
let quality: Quality = "high";
let autoDowngraded = false;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function recompute() {
  resolved = resolveSettings(quality, overrides);
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(OVERRIDES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const clean: Record<string, boolean | number> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) clean[k] = v;
      overrides = clean as GraphicsOverrides;
    }
  } catch {
    overrides = {};
  }
  try {
    const saved = window.localStorage.getItem(QUALITY_KEY);
    if (saved === "high" || saved === "medium" || saved === "low") {
      quality = saved;
      recompute();
      return;
    }
  } catch {
    // storage unavailable — fall through to detection
  }
  quality = detectDefaultQuality();
  recompute();
}

function saveOverrides() {
  try {
    window.localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // ignore
  }
}

/** Switches one option on top of the current preset. Setting it back to the preset's own value drops the override. */
export function setGraphicsOption<K extends keyof GraphicsOverrides>(key: K, value: GraphicsOverrides[K]): void {
  hydrate();
  const base = resolveSettings(quality, {});
  const baseValue = key === "dprMax" ? base.dpr[1] : (base as unknown as Record<string, unknown>)[key as string];
  const next = { ...overrides };
  if (value === baseValue || value === undefined) delete next[key];
  else next[key] = value;
  overrides = next;
  saveOverrides();
  recompute();
  emit();
}

/** The player's individual overrides, for showing which options differ from the preset. */
export function getGraphicsOverrides(): GraphicsOverrides {
  hydrate();
  return overrides;
}

export function setQuality(value: Quality, auto = false): void {
  hydrate();
  if (value === quality) return;
  const wasLower = ORDER.indexOf(value) > ORDER.indexOf(quality);
  quality = value;
  autoDowngraded = auto && wasLower;
  // Picking a preset means "use that preset": it replaces any individual tweaks.
  if (!auto) {
    overrides = {};
    saveOverrides();
  }
  recompute();
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

/** The settings in force: the chosen preset with the player's own tweaks applied. Stable between changes. */
export function useGraphics(): QualitySettings {
  return useSyncExternalStore(
    subscribe,
    () => {
      hydrate();
      return resolved;
    },
    () => QUALITY_SETTINGS.high
  );
}

/** Same as `useGraphics`, for code outside React (e.g. the vehicle cap sent to the worker). */
export function currentGraphics(): QualitySettings {
  hydrate();
  return resolved;
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
