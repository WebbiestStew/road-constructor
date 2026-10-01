"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { pushToast } from "@/lib/toast";
import { clearEdits, finishEdit, relabelEdit, startEdit } from "@/lib/editLog";

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

type EditorState = ReturnType<typeof useEditorStore.getState>;

/** What the traffic tools can change: speed limits, lane arrows, and each junction's control. */
interface Snap {
  speed: Map<string, number>;
  arrows: Map<string, string>;
  control: Map<string, string>;
}

function snapshot(state: EditorState): Snap {
  return {
    speed: new Map(state.edges.map((e) => [e.id, e.speedLimitMph])),
    arrows: new Map(state.edges.map((e) => [e.id, e.laneMoves ? JSON.stringify(e.laneMoves) : ""])),
    control: new Map(state.nodes.map((n) => [n.id, n.control ? JSON.stringify(n.control) : ""])),
  };
}

/** Plain-English description of what differs between two snapshots (empty if nothing the tools touch changed). */
function describe(prev: Snap, next: Snap, state: EditorState): string[] {
  const labels: string[] = [];

  const speedChanges: { from: number; to: number }[] = [];
  for (const [id, to] of next.speed) {
    const from = prev.speed.get(id);
    if (from !== undefined && from !== to) speedChanges.push({ from, to });
  }
  if (speedChanges.length > 0) {
    const { from, to } = speedChanges[0];
    labels.push(`Speed limit ${from} → ${to} mph${speedChanges.length > 2 ? " (whole road)" : ""}`);
  }

  let arrowEdits = 0;
  for (const [id, now] of next.arrows) if (prev.arrows.has(id) && prev.arrows.get(id) !== now) arrowEdits++;
  if (arrowEdits > 0) labels.push("Lane arrows changed");

  for (const [id, now] of next.control) {
    const before = prev.control.get(id);
    if (before === undefined || before === now) continue;
    const a = before ? (JSON.parse(before) as { type: string; greenDurationS?: number; offsetS?: number }) : null;
    const b = now ? (JSON.parse(now) as { type: string; greenDurationS?: number; offsetS?: number }) : null;
    if (b?.type === "signal" && a?.type !== "signal") labels.push("Added a traffic light");
    else if (a?.type === "signal" && b?.type !== "signal") labels.push("Light → priority junction");
    else if (a && b && a.greenDurationS !== b.greenDurationS) labels.push(`Green ${a.greenDurationS}s → ${b.greenDurationS}s`);
    else if (a && b && (a.offsetS ?? 0) !== (b.offsetS ?? 0)) labels.push(`Light offset ${a.offsetS ?? 0}s → ${b.offsetS ?? 0}s`);
    else labels.push("Junction changed");
  }
  void state;
  return labels;
}

/**
 * Closes the loop after a traffic-management edit: it remembers how fast traffic was moving, waits for the change
 * to play out, and then tells the player what it did — so a lane arrow or a new speed limit gets an answer
 * instead of silence. Also cheers when every jam clears. Renders nothing; it speaks through toasts.
 */
export default function FlowFeedback({ sim }: { sim: UseTrafficSimulationReturn }) {
  const history = useRef<Sample[]>([]);
  const latest = useRef({ simTime: 0 });
  const pending = useRef<{ baseline: number; evalAt: number; entryId: number; labels: string[] } | null>(null);
  const lastProblems = useRef(0);

  // Sample the live numbers (they arrive ~5x/s) and judge any edit whose settling time is up.
  useEffect(() => {
    const m = sim.metrics;
    if (m.simTime < latest.current.simTime) {
      // a fresh run restarted the clock: old readings and old edits no longer apply
      history.current = [];
      pending.current = null;
      clearEdits();
    }
    latest.current.simTime = m.simTime;
    history.current.push({ t: m.simTime, v: m.avgSpeedMph, n: m.activeCount });
    history.current = history.current.filter((s) => s.t >= m.simTime - 60);

    const p = pending.current;
    if (p && m.simTime >= p.evalAt) {
      pending.current = null;
      const after = mean(history.current.filter((s) => s.t >= m.simTime - AFTER_WINDOW_S));
      if (after !== null) {
        const delta = after - p.baseline;
        finishEdit(p.entryId, delta);
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
    let prev = snapshot(useEditorStore.getState());
    return useEditorStore.subscribe((state) => {
      const next = snapshot(state);
      const labels = describe(prev, next, state);
      prev = next;
      if (labels.length === 0 || state.mode !== "simulate") return;
      const now = latest.current.simTime;
      const p = pending.current;
      if (p) {
        // Several tweaks in a row: judge them together, from the reading before the first one.
        p.evalAt = now + SETTLE_S;
        p.labels = [...p.labels, ...labels];
        relabelEdit(p.entryId, p.labels.slice(0, 2).join(" + ") + (p.labels.length > 2 ? ` +${p.labels.length - 2}` : ""));
        return;
      }
      const baseline = mean(history.current.filter((s) => s.t >= now - BEFORE_WINDOW_S));
      if (baseline === null) return;
      pending.current = { baseline, evalAt: now + SETTLE_S, entryId: startEdit(labels.slice(0, 2).join(" + ")), labels };
    });
  }, []);

  return null;
}
