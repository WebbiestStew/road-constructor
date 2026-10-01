"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { useChaos } from "@/lib/chaos";
import { pushToast } from "@/lib/toast";

/** Sim-seconds a breakdown blocks its lane. Kept under the 25 s gridlock-despawn timer so queued cars aren't deleted. */
const BREAKDOWN_S = 18;
const RUSH_HOUR_S = 40;
const RUSH_MULTIPLIER = 1.6;
const FIRST_EVENT_DELAY_S = 25;

function between(min: number, max: number) {
  return min + Math.random() * (max - min);
}

/**
 * Chaos mode: while traffic runs, now and then something goes wrong. A car breaks down in the road, or rush hour
 * hits and every entry surges for a while, so a layout that only works in calm conditions gets tested. It is only
 * active in free play: campaign levels are scored against a fixed, repeatable run, and random events would make
 * that unfair. Renders nothing.
 */
export default function ChaosDirector({ sim }: { sim: UseTrafficSimulationReturn }) {
  const chaos = useChaos();
  const scenarioActive = useEditorStore((s) => s.activeScenarioId !== null);
  const mode = useEditorStore((s) => s.mode);
  const live = chaos && !scenarioActive && mode === "simulate" && sim.running;

  const simTime = sim.metrics.simTime;
  const nextEventAt = useRef<number | null>(null);
  const rushUntil = useRef<number | null>(null);
  const rushBase = useRef<Map<string, number> | null>(null);
  const lastIncidents = useRef(0);
  const { setDemand, triggerBreakdown } = sim;

  // Put entry demand back exactly as it was.
  const endRush = useRef(() => {});
  useEffect(() => {
    endRush.current = () => {
      const base = rushBase.current;
      if (base) for (const [edgeId, vph] of base) setDemand(edgeId, vph);
      rushBase.current = null;
      rushUntil.current = null;
    };
  }, [setDemand]);

  // Leaving Chaos (or the sim stopping) must not strand an inflated demand or a stale schedule.
  useEffect(() => {
    if (live) return;
    endRush.current();
    nextEventAt.current = null;
  }, [live]);

  useEffect(() => {
    if (!live) return;
    if (nextEventAt.current === null) nextEventAt.current = simTime + FIRST_EVENT_DELAY_S;

    if (rushUntil.current !== null && simTime >= rushUntil.current) {
      endRush.current();
      pushToast("😮‍💨 Rush hour is over", "info");
    }

    if (simTime < nextEventAt.current) return;
    nextEventAt.current = simTime + between(30, 55);

    const canRush = rushUntil.current === null;
    if (canRush && Math.random() < 0.4) {
      const base = new Map<string, number>();
      for (const e of useEditorStore.getState().edges) {
        if (e.zone?.type === "entry") base.set(e.id, e.zone.demandVehPerHour);
      }
      if (base.size === 0) return;
      rushBase.current = base;
      rushUntil.current = simTime + RUSH_HOUR_S;
      for (const [edgeId, vph] of base) setDemand(edgeId, Math.round(vph * RUSH_MULTIPLIER));
      pushToast("🚗💨 RUSH HOUR! Demand is up 60% for 40 seconds", "alert");
    } else {
      triggerBreakdown(BREAKDOWN_S);
    }
  }, [live, simTime, setDemand, triggerBreakdown]);

  // The worker confirms a breakdown by listing it; announce each new one.
  const incidents = sim.metrics.incidentMarkers.length;
  useEffect(() => {
    if (incidents > lastIncidents.current && live) {
      pushToast("🚨 Breakdown! A car has stalled in the road. Watch the queue build", "alert");
    }
    lastIncidents.current = incidents;
  }, [incidents, live]);

  return null;
}
