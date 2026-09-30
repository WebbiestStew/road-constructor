"use client";

import { useEffect, useRef, useState } from "react";
import type { NetworkSnapshot, WorkerInMessage, WorkerOutMessage } from "@/sim/types";
import { ftpsToMph } from "@/sim/types";
import { VEHICLE_CAP, useQuality } from "@/lib/quality";
import type { VehicleSnapshot } from "./useTrafficSimulation";

export interface DemoStats {
  cars: number;
  avgSpeedMph: number;
  throughputPerMinute: number;
}

const DEMO_SEED = 2024;
/** Demo runs faster than real time so the scene is busy within seconds of the traffic opening. */
const DEMO_SPEED = 2;

/**
 * Standalone simulation for the landing page hero. Same worker and renderer
 * hand-off as the game, but fully decoupled from the editor store: traffic
 * starts once `active` flips true, and pauses whenever `visible` is false.
 */
export function useDemoTraffic(network: NetworkSnapshot, active: boolean, visible: boolean) {
  const snapshotRef = useRef<VehicleSnapshot | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingReturnRef = useRef<{ matrices: ArrayBuffer; colors: ArrayBuffer; taillightColors: ArrayBuffer } | null>(null);
  const versionRef = useRef(0);
  const lastStatsRef = useRef(0);
  const [stats, setStats] = useState<DemoStats>({ cars: 0, avgSpeedMph: 0, throughputPerMinute: 0 });
  const [failed, setFailed] = useState(false);
  const quality = useQuality();

  useEffect(() => {
    const worker = new Worker(new URL("../sim/worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      if (msg.type !== "tick") return;

      const pending = pendingReturnRef.current;
      if (pending) {
        worker.postMessage(
          {
            type: "returnBuffers",
            matrices: pending.matrices,
            colors: pending.colors,
            taillightColors: pending.taillightColors,
          } satisfies WorkerInMessage,
          [pending.matrices, pending.colors, pending.taillightColors]
        );
      }
      pendingReturnRef.current = { matrices: msg.matrices, colors: msg.colors, taillightColors: msg.taillightColors };

      versionRef.current += 1;
      snapshotRef.current = {
        matrices: new Float32Array(msg.matrices),
        colors: new Float32Array(msg.colors),
        taillightColors: new Float32Array(msg.taillightColors),
        activeCount: msg.activeCount,
        version: versionRef.current,
      };

      const now = performance.now();
      if (now - lastStatsRef.current >= 500) {
        lastStatsRef.current = now;
        setStats({
          cars: msg.activeCount,
          avgSpeedMph: ftpsToMph(msg.avgSpeedFtS),
          throughputPerMinute: msg.throughputLastMinute,
        });
      }
    };
    worker.onerror = () => setFailed(true);
    worker.postMessage({ type: "setSpeedMultiplier", value: DEMO_SPEED } satisfies WorkerInMessage);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "setMaxVehicles", value: VEHICLE_CAP[quality] } satisfies WorkerInMessage);
  }, [quality]);

  // Load the full city into the sim once traffic is due to open.
  useEffect(() => {
    if (!active) return;
    workerRef.current?.postMessage({ type: "updateNetwork", network, seed: DEMO_SEED } satisfies WorkerInMessage);
  }, [active, network]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "setRunning", running: active && visible } satisfies WorkerInMessage);
  }, [active, visible]);

  return { snapshotRef, stats, failed };
}
