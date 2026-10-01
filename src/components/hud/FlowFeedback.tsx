"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { pushToast } from "@/lib/toast";

/** Sim-seconds of history averaged for the "before" reading. */
const BEFORE_WINDOW_S = 8;
/** Sim-seconds to wait after the last edit before judging it — long enough for the change to reach the whole road. */
const SETTLE_S = 22;
/** Sim-seconds averaged for the "after" reading. */
const AFTER_WINDOW_S = 6;
const MIN_CARS = 15;

interface Sample {
  t: number;
  v: number;
  n: number;
}

function mean(samples: Sample[]): number | null {
  const usable = samples.filter((s) => s.n >= MIN_CARS);
  if (usable.length < 4) return null;
  return usable.reduce((a, s) => a + s.v, 0) / usable.length;
}

/** What the traffic tools can change: speed limits, lane arrows, and who has a signal. Any difference means the player just did something. */
function editSignature(state: ReturnType<typeof useEditorStore.getState>): string {
  const e = state.edges.map((x) => `${x.id}:${x.speedLimitMph}:${x.laneMoves ? JSON.stringify(x.laneMoves) : ""}`).join("|");
  const n = state.nodes.map((x) => (x.control ? `${x.id}:${JSON.stringify(x.control)}` : "")).join("|");
  return `${e}#${n}`;
}

/**
 * Closes the loop after a traffic-management edit: it remembers how fast traffic was moving, waits for the change
 * to play out, and then tells the player what it did — so a lane arrow or a new speed limit gets an answer
 * instead of silence. Also cheers when every jam clears. Renders nothing; it speaks through toasts.
 */
export default function FlowFeedback({ sim }: { sim: UseTrafficSimulationReturn }) {
  const history = useRef<Sample[]>([]);
  const latest = useRef({ simTime: 0 });
  const pending = useRef<{ baseline: number; evalAt: number } | null>(null);
  const lastProblems = useRef(0);

  // Sample the live numbers (they arrive ~5x/s) and judge any edit whose settling time is up.
  useEffect(() => {
    const m = sim.metrics;
    if (m.simTime < latest.current.simTime) history.current = []; // a fresh run restarted the clock
    latest.current.simTime = m.simTime;
    history.current.push({ t: m.simTime, v: m.avgSpeedMph, n: m.activeCount });
    history.current = history.current.filter((s) => s.t >= m.simTime - 60);

    const p = pending.current;
    if (p && m.simTime >= p.evalAt) {
      pending.current = null;
      const after = mean(history.current.filter((s) => s.t >= m.simTime - AFTER_WINDOW_S));
      if (after !== null) {
        const delta = after - p.baseline;
        if (delta >= 3) pushToast(`📈 Nice! Traffic is moving ${Math.round(delta)} mph faster`, "good");
        else if (delta >= 1.5) pushToast(`👍 A little better: +${delta.toFixed(1)} mph`, "good");
        else if (delta <= -3) pushToast(`📉 That slowed traffic by ${Math.round(-delta)} mph. Ctrl+Z to undo?`, "bad");
        else if (delta <= -1.5) pushToast(`😬 Slightly slower (${delta.toFixed(1)} mph). Try another way?`, "alert");
        else pushToast("🤔 Not much change yet. Give it a minute or try something bigger", "info");
      }
    }

    const problems = m.problemEdgeIds.length;
    if (lastProblems.current > 0 && problems === 0 && m.activeCount > 20) {
      pushToast("✅ Every jam cleared! Nicely done", "good");
    }
    lastProblems.current = problems;
  }, [sim.metrics]);

  // Notice the player's edits.
  useEffect(() => {
    let prev = editSignature(useEditorStore.getState());
    return useEditorStore.subscribe((state) => {
      const sig = editSignature(state);
      if (sig === prev) return;
      prev = sig;
      if (state.mode !== "simulate") return;
      const now = latest.current.simTime;
      if (pending.current) {
        // Several tweaks in a row: judge them together, from the reading before the first one.
        pending.current.evalAt = now + SETTLE_S;
        return;
      }
      const baseline = mean(history.current.filter((s) => s.t >= now - BEFORE_WINDOW_S));
      if (baseline !== null) pending.current = { baseline, evalAt: now + SETTLE_S };
    });
  }, []);

  return null;
}
