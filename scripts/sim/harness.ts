// Runs the real simulation worker in Node: stub `self`, import it, drive it with messages.
// src/sim has no DOM or React dependencies, so this is the same code the browser runs.
import type { NetworkSnapshot, WorkerInMessage, WorkerOutMessage } from "../../src/sim/types";

export interface Tick {
  simTime: number;
  activeCount: number;
  avgMph: number;
  trips: number;
  problems: string[];
}

export async function createSim() {
  const g = globalThis as unknown as Record<string, unknown> & { onmessage: (e: { data: WorkerInMessage }) => void };
  let last: Tick | null = null;
  g.self = g;
  g.postMessage = (m: WorkerOutMessage) => {
    if (m.type !== "tick") return;
    const t = m as unknown as {
      simTime: number;
      activeCount: number;
      avgSpeedFtS: number;
      completedTripsTotal: number;
      stats?: { problemEdgeIds: string[] };
    };
    last = {
      simTime: t.simTime,
      activeCount: t.activeCount,
      avgMph: t.avgSpeedFtS * 0.681818,
      trips: t.completedTripsTotal,
      problems: t.stats?.problemEdgeIds ?? last?.problems ?? [],
    };
  };
  await import("../../src/sim/worker");
  const send = (m: WorkerInMessage) => g.onmessage({ data: m });
  return {
    load(network: NetworkSnapshot, seed = 1337, speed = 20) {
      send({ type: "setSpeedMultiplier", value: speed });
      send({ type: "updateNetwork", network, seed });
      send({ type: "setRunning", running: true });
    },
    /** Runs until simulated time reaches `simSeconds`, faster than real time. */
    async runUntil(simSeconds: number): Promise<Tick> {
      while ((last?.simTime ?? 0) < simSeconds) await new Promise((r) => setTimeout(r, 15));
      return last!;
    },
  };
}

export function cloneNetwork(n: NetworkSnapshot): NetworkSnapshot {
  return JSON.parse(JSON.stringify(n));
}
