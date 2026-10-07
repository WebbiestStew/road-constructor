"use client";

import type { Quality } from "./quality";

/**
 * What this device can do, measured rather than guessed. The game has three quality tiers and steps down on its own when
 * frames get slow, but the numbers that tune those thresholds have to come from real phones and laptops. The settings
 * menu's "Test this device" measures the live scene for a few seconds, says which tier fits, and can copy a plain-text
 * report to send back (it holds no personal data: the graphics card's name, the screen size, the frame times).
 */

export interface DeviceInfo {
  renderer: string;
  vendor: string;
  cores: number;
  memoryGb: number | null;
  pixelRatio: number;
  screen: string;
  touch: boolean;
  browser: string;
}

export interface FrameResult {
  seconds: number;
  frames: number;
  avgFps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Frames that took over 50 ms (a visible hitch). */
  hitches: number;
  /** Main-thread tasks over 50 ms seen meanwhile, where the browser reports them. */
  longTasks: number;
}

export type Verdict = "smooth" | "playable" | "choppy";

/** Events the frame-rate guard has logged this session (it stepped quality down, or shed overlays), for the report. */
const guardEvents: string[] = [];

export function noteGuardEvent(text: string): void {
  guardEvents.push(`${(performance.now() / 1000).toFixed(0)}s: ${text}`);
  if (guardEvents.length > 20) guardEvents.shift();
}

export function gatherDeviceInfo(): DeviceInfo {
  let renderer = "unknown";
  let vendor = "unknown";
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) {
      renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
      vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL));
    } else if (gl) {
      renderer = String(gl.getParameter(gl.RENDERER));
      vendor = String(gl.getParameter(gl.VENDOR));
    }
  } catch {
    // no WebGL: the game would not be running
  }
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { brands?: { brand: string; version: string }[]; mobile?: boolean } };
  const brand = nav.userAgentData?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(", ");
  return {
    renderer,
    vendor,
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: nav.deviceMemory ?? null,
    pixelRatio: window.devicePixelRatio || 1,
    screen: `${window.screen.width}x${window.screen.height}`,
    touch: navigator.maxTouchPoints > 0,
    browser: brand || navigator.userAgent.slice(0, 80),
  };
}

/** Pure: summarises frame durations (milliseconds) into the numbers the report and the verdict use. */
export function summariseFrames(durationsMs: number[], longTasks = 0): FrameResult {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const pick = (q: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  const total = durationsMs.reduce((a, b) => a + b, 0);
  return {
    seconds: total / 1000,
    frames: durationsMs.length,
    avgFps: total > 0 ? (durationsMs.length * 1000) / total : 0,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    hitches: durationsMs.filter((d) => d > 50).length,
    longTasks,
  };
}

/** Pure: how it went, and which tier would suit this device. A frame that takes over ~34 ms is a visible stutter. */
export function judge(result: FrameResult, tier: Quality, targetFps: number): { verdict: Verdict; suggest: Quality; reason: string } {
  const budgetMs = 1000 / Math.min(60, targetFps);
  const order: Quality[] = ["low", "medium", "high"];
  const i = order.indexOf(tier);
  if (result.frames < 30) return { verdict: "playable", suggest: tier, reason: "Too few frames to judge: run it with traffic moving." };
  if (result.p95Ms > 34 || result.avgFps < 24) {
    return { verdict: "choppy", suggest: order[Math.max(0, i - 1)], reason: `The slowest 5% of frames took ${result.p95Ms.toFixed(0)} ms (a smooth game needs under ${budgetMs.toFixed(0)}).` };
  }
  if (result.p95Ms <= budgetMs * 1.15 && result.hitches === 0) {
    return { verdict: "smooth", suggest: tier === "low" || tier === "medium" ? order[Math.min(2, i + 1)] : tier, reason: i < 2 ? "Plenty of headroom: a higher tier should run well." : "Runs well at this tier." };
  }
  return { verdict: "playable", suggest: tier, reason: `The slowest 5% of frames took ${result.p95Ms.toFixed(0)} ms: playable, with the odd hitch.` };
}

/** Measures frame times over the live scene for `ms` milliseconds. */
export function measureFrames(ms: number, onProgress?: (fraction: number) => void): Promise<FrameResult> {
  return new Promise((resolve) => {
    const durations: number[] = [];
    let longTasks = 0;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        longTasks += list.getEntries().length;
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      observer = null;
    }
    const start = performance.now();
    let last = start;
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      // a tab that was in the background reports one giant frame: not the game's doing
      if (dt < 1000) durations.push(dt);
      onProgress?.(Math.min(1, (now - start) / ms));
      if (now - start >= ms) {
        observer?.disconnect();
        resolve(summariseFrames(durations.slice(1), longTasks));
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** The plain-text report: device, graphics settings, the measurement and what the guard did. */
export function buildReport(info: DeviceInfo, tier: Quality, settingsNote: string, result: FrameResult | null, extra: { activeCars: number; simSpeed: number }): string {
  const lines = [
    "Road Constructor performance report",
    `Graphics card: ${info.renderer} (${info.vendor})`,
    `Browser: ${info.browser}`,
    `Cores: ${info.cores || "?"}, memory: ${info.memoryGb ?? "?"} GB, pixel ratio ${info.pixelRatio}, screen ${info.screen}${info.touch ? ", touch" : ""}`,
    `Quality: ${tier}${settingsNote ? ` (${settingsNote})` : ""}`,
    `Scene: ${extra.activeCars} cars, sim speed ${extra.simSpeed}x`,
  ];
  if (result) {
    lines.push(
      `Frames: ${result.frames} in ${result.seconds.toFixed(1)} s = ${result.avgFps.toFixed(1)} fps average`,
      `Frame time: median ${result.p50Ms.toFixed(1)} ms, 95th percentile ${result.p95Ms.toFixed(1)} ms, 99th ${result.p99Ms.toFixed(1)} ms`,
      `Hitches over 50 ms: ${result.hitches}, long tasks: ${result.longTasks}`
    );
  } else lines.push("No measurement taken yet.");
  lines.push(`Frame-rate guard this session: ${guardEvents.length > 0 ? guardEvents.join("; ") : "did nothing"}`);
  return lines.join("\n");
}
