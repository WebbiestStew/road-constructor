// Runs the real simulation worker in Node: stub `self`, import it, drive it with messages.
// src/sim has no DOM or React dependencies, so this is the same code the browser runs.
import type { IncidentView, NetworkSnapshot, WorkerInMessage, WorkerOutMessage } from "../../src/sim/types";

export interface Tick {
  simTime: number;
  activeCount: number;
  avgMph: number;
  trips: number;
  people: number;
  delayS: number;
  freeFlowS: number;
  timedTrips: number;
  queuePeakFt: number;
  problems: string[];
  incidents: IncidentView[];
  jakeBrakes: number;
  rageCount: number;
  combos: number;
}

/** Completed trips at each tick's sim time, for comparing two runs tick by tick. */
export const tripSeries = new Map<number, number>();

/** Every action the worker logged (see LoggedAction), collected from the ticks. */
export const loggedActions: import("../../src/sim/types").LoggedAction[] = [];

export async function createSim() {
  const g = globalThis as unknown as Record<string, unknown> & { onmessage: (e: { data: WorkerInMessage }) => void };
  let last: Tick | null = null;
  /** Callers waiting for the simulated clock to reach a time. They are answered from the first tick at or past it, not from whatever has arrived by the time a timer fires: the sim runs far faster than real time, so polling would make the answer depend on how busy the machine is. */
  const waiters: { t: number; resolve: (tick: Tick) => void }[] = [];
  g.self = g;
  g.postMessage = (m: WorkerOutMessage) => {
    if (m.type !== "tick") return;
    g.__simLast = m;
    tripSeries.set(Math.round((m as unknown as { simTime: number }).simTime * 1000), (m as unknown as { completedTripsTotal: number }).completedTripsTotal);
    const acts = (m as unknown as { actions?: import("../../src/sim/types").LoggedAction[] }).actions;
    if (acts) loggedActions.push(...acts);
    const t = m as unknown as {
      simTime: number;
      activeCount: number;
      avgSpeedFtS: number;
      completedTripsTotal: number;
      peopleMovedTotal?: number;
      tripDelayTotalS?: number;
      tripFreeFlowTotalS?: number;
      tripsTimed?: number;
      queuePeakFt?: number;
      incidents?: IncidentView[];
      jakeBrakes?: unknown[];
      rageCount?: number;
      combos?: number;
      stats?: { problemEdgeIds: string[] };
    };
    last = {
      simTime: t.simTime,
      activeCount: t.activeCount,
      avgMph: t.avgSpeedFtS * 0.681818,
      trips: t.completedTripsTotal,
      people: t.peopleMovedTotal ?? 0,
      delayS: t.tripDelayTotalS ?? 0,
      freeFlowS: t.tripFreeFlowTotalS ?? 0,
      timedTrips: t.tripsTimed ?? 0,
      queuePeakFt: t.queuePeakFt ?? 0,
      problems: t.stats?.problemEdgeIds ?? last?.problems ?? [],
      incidents: t.incidents ?? [],
      jakeBrakes: t.jakeBrakes?.length ?? 0,
      rageCount: t.rageCount ?? 0,
      combos: t.combos ?? 0,
    };
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (last.simTime >= waiters[i].t) {
        waiters[i].resolve({ ...last, incidents: last.incidents });
        waiters.splice(i, 1);
      }
    }
  };
  await import("../../src/sim/worker");
  const send = (m: WorkerInMessage) => g.onmessage({ data: m });
  return {
    send,
    load(network: NetworkSnapshot, seed = 1337, speed = 20) {
      send({ type: "setSpeedMultiplier", value: speed });
      send({ type: "updateNetwork", network, seed });
      send({ type: "setRunning", running: true });
    },
    /** Runs until simulated time reaches `simSeconds`, faster than real time. */
    runUntil(simSeconds: number): Promise<Tick> {
      return new Promise((resolve) => waiters.push({ t: simSeconds, resolve }));
    },
  };
}

/** Simulated seconds per real second. The worker's loop can do 40 (30 Hz frames x 40 steps); it steps at a fixed dt, so the speed changes only how fast a run finishes. */
export const HARNESS_SPEED = 40;

export function cloneNetwork(n: NetworkSnapshot): NetworkSnapshot {
  return JSON.parse(JSON.stringify(n));
}
