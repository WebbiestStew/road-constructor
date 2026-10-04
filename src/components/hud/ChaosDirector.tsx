"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { useChaos } from "@/lib/chaos";
import { pushToast } from "@/lib/toast";
import { clearPanic, setPanic } from "@/lib/panic";

/** Sim-seconds a breakdown blocks its lane. Kept under the 25 s gridlock-despawn timer so queued cars aren't deleted. */
const BREAKDOWN_S = 18;
const RUSH_HOUR_S = 40;
const RUSH_MULTIPLIER = 1.6;
const FIRST_EVENT_DELAY_S = 25;
/** Seconds of warning, on the banner, before an announced event lands. */
const WARNING_S = 10;
const VENUES = ["STADIUM LETS OUT", "CONCERT ENDS", "SHIFT CHANGE AT THE PLANT", "FOOTBALL MATCH ENDS", "FESTIVAL CROWD HEADING HOME"];

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
  const { setDemand, triggerBreakdown, triggerAmbulance, triggerCrash, triggerIncident } = sim;

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

  // The trouble that has been announced and is counting down.
  const pending = useRef<{ id: string; text: string; fireAt: number; run: () => void } | null>(null);

  useEffect(() => {
    if (!live) {
      if (pending.current) {
        clearPanic(pending.current.id);
        pending.current = null;
      }
      return;
    }
    if (nextEventAt.current === null) nextEventAt.current = simTime + FIRST_EVENT_DELAY_S;

    if (rushUntil.current !== null && simTime >= rushUntil.current) {
      endRush.current();
      pushToast("😮‍💨 Rush hour is over", "info");
    }

    // Count down an announced event, and let it loose when the banner runs out.
    const p = pending.current;
    if (p) {
      if (simTime >= p.fireAt) {
        clearPanic(p.id);
        pending.current = null;
        p.run();
      } else {
        setPanic({ id: p.id, text: p.text, secondsLeft: p.fireAt - simTime });
      }
      return;
    }

    if (simTime < nextEventAt.current) return;
    nextEventAt.current = simTime + WARNING_S + between(25, 45);

    const state = useEditorStore.getState();
    const streets = state.edges.filter((e) => e.name && !e.ramp && !e.isRoundaboutRing && !e.isTexasTurnaround && e.roadClassId !== "lane");
    const street = streets.length > 0 ? streets[Math.floor(Math.random() * streets.length)] : null;
    const announce = (text: string, run: () => void) => {
      pending.current = { id: `chaos-${simTime}`, text, fireAt: simTime + WARNING_S, run };
      setPanic({ id: pending.current.id, text, secondsLeft: WARNING_S });
    };

    const canRush = rushUntil.current === null;
    const roll = Math.random();
    if (canRush && roll < 0.35) {
      const base = new Map<string, number>();
      for (const e of state.edges) {
        if (e.zone?.type === "entry") base.set(e.id, e.zone.demandVehPerHour);
      }
      if (base.size === 0) return;
      let perHour = 0;
      for (const v of base.values()) perHour += v;
      const extra = Math.max(20, Math.round(((perHour * (RUSH_MULTIPLIER - 1) * RUSH_HOUR_S) / 3600) / 10) * 10);
      const venue = state.placeName ? `${state.placeName.toUpperCase()}: EVENT LETS OUT` : VENUES[Math.floor(Math.random() * VENUES.length)];
      announce(`${venue} - ${extra} VEHICLES INBOUND`, () => {
        rushBase.current = base;
        rushUntil.current = simTime + RUSH_HOUR_S;
        for (const [edgeId, vph] of base) setDemand(edgeId, Math.round(vph * RUSH_MULTIPLIER));
        pushToast("🚗💨 RUSH HOUR! Demand is up 60% for 40 seconds", "alert");
      });
    } else if (roll < 0.6 && street) {
      announce(`OIL SPILL ON ${street.name!.toUpperCase()} - LANE BLOCKED`, () => triggerIncident("debris", street.id));
    } else if (roll < 0.7) {
      announce("MULTI-CAR PILE-UP REPORTED - POLICE DISPATCHED", () => triggerCrash());
    } else if (roll < 0.8) {
      announce("AMBULANCE ON THE WAY - CLEAR A LANE", () => triggerAmbulance());
    } else if (roll < 0.9) {
      announce("18-WHEELER LOSING POWER - EXPECT A BLOCKED LANE", () => triggerIncident("stall"));
    } else {
      announce("CAR BREAKING DOWN AHEAD", () => triggerBreakdown(BREAKDOWN_S));
    }
  }, [live, simTime, setDemand, triggerBreakdown, triggerAmbulance, triggerCrash, triggerIncident]);

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
