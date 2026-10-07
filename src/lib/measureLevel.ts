"use client";

import type { NetworkSnapshot, WorkerInMessage, WorkerOutMessage } from "@/sim/types";

/**
 * Measures how a city does when nobody touches it, by running the real simulation in spare workers at full speed: the
 * same numbers the headless test harness uses to set a level's star lines. A few seeds are run (in parallel where the
 * machine has cores to spare) and averaged, because one seed can be luckier than another.
 */

export const MEASURE_RUN_S = 300;
export const MEASURE_SEEDS = [1337, 2024, 77];
/** The speed the spare workers run at: the sim's loop does at most 40 steps a frame. */
const MEASURE_SPEED = 40;

export interface SeedProgress {
  seed: number;
  /** 0-1 of the run. */
  progress: number;
  done: boolean;
}

export interface Measurement {
  /** Mean vehicles moved over the seeds: what the unchanged city does. */
  baseline: number;
  /** Mean of the seeds' own results, lowest to highest, to show how much they vary. */
  trips: number[];
  /** Trip delay as a share of the empty-road time, and the longest queue (ft), averaged. */
  delayShare: number;
  queueFt: number;
  /** (highest - lowest) / mean: how much the seeds disagreed. */
  spread: number;
}

interface SeedResult {
  trips: number;
  delayShare: number | null;
  queueFt: number;
}

function runSeed(
  network: NetworkSnapshot,
  mix: { bus: number; bike: number },
  seed: number,
  onProgress: (p: number) => void,
  signal: AbortSignal
): Promise<SeedResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../sim/worker.ts", import.meta.url), { type: "module" });
    const stop = () => worker.terminate();
    const abort = () => {
      stop();
      reject(new DOMException("Measurement cancelled", "AbortError"));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    let started = false;
    const send = (m: WorkerInMessage) => worker.postMessage(m);
    worker.onerror = (e) => {
      stop();
      reject(new Error(e.message || "The simulation worker failed"));
    };
    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      if (msg.type === "ready" && !started) {
        started = true;
        // exactly what a level run starts with (see useTrafficSimulation)
        send({ type: "setSpeedMultiplier", value: MEASURE_SPEED });
        send({ type: "reset" });
        send({ type: "updateNetwork", network, seed });
        send({ type: "setLeftTurnsYield", enabled: false });
        send({ type: "setRageWeaves", enabled: false });
        send({ type: "setTrafficMix", bus: mix.bus, bike: mix.bike });
        send({ type: "setRunning", running: true });
        return;
      }
      if (msg.type !== "tick") return;
      // hand the buffers back so the worker can reuse them rather than allocate a new set every tick
      worker.postMessage({ type: "returnBuffers", matrices: msg.matrices, colors: msg.colors, taillightColors: msg.taillightColors } satisfies WorkerInMessage, [msg.matrices, msg.colors, msg.taillightColors]);
      onProgress(Math.min(1, msg.simTime / MEASURE_RUN_S));
      if (msg.simTime >= MEASURE_RUN_S) {
        signal.removeEventListener("abort", abort);
        stop();
        resolve({
          trips: msg.completedTripsTotal,
          delayShare: msg.tripFreeFlowTotalS > 0 && msg.tripsTimed >= 15 ? msg.tripDelayTotalS / msg.tripFreeFlowTotalS : null,
          queueFt: msg.queuePeakFt ?? 0,
        });
      }
    };
  });
}

/** Runs the city for MEASURE_RUN_S sim-seconds under each seed and averages. Rejects if cancelled (AbortError) or a worker fails. */
export async function measureCity(
  network: NetworkSnapshot,
  mix: { bus: number; bike: number },
  onProgress: (seeds: SeedProgress[]) => void,
  signal: AbortSignal
): Promise<Measurement> {
  const progress: SeedProgress[] = MEASURE_SEEDS.map((seed) => ({ seed, progress: 0, done: false }));
  const emit = () => onProgress(progress.map((p) => ({ ...p })));
  emit();
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  const parallel = Math.max(1, Math.min(MEASURE_SEEDS.length, cores - 1));
  const results: SeedResult[] = new Array(MEASURE_SEEDS.length);
  let next = 0;
  const lane = async () => {
    while (next < MEASURE_SEEDS.length) {
      const i = next++;
      results[i] = await runSeed(
        network,
        mix,
        MEASURE_SEEDS[i],
        (p) => {
          progress[i].progress = p;
          emit();
        },
        signal
      );
      progress[i].done = true;
      progress[i].progress = 1;
      emit();
    }
  };
  await Promise.all(Array.from({ length: parallel }, lane));
  const trips = results.map((r) => r.trips).sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const delays = results.map((r) => r.delayShare).filter((d): d is number => d !== null);
  const baseline = mean(trips);
  return {
    baseline: Math.round(baseline),
    trips,
    delayShare: delays.length > 0 ? mean(delays) : 0,
    queueFt: Math.round(mean(results.map((r) => r.queueFt))),
    spread: baseline > 0 ? (trips[trips.length - 1] - trips[0]) / baseline : 0,
  };
}
