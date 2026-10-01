"use client";

import { useEffect, useState } from "react";
import { useEditorStore } from "@/state/editorStore";
import { useEditLog } from "@/lib/editLog";

const KEY = "road-constructor:coach:v1";

function alreadyCoached(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return true; // can't remember it, so don't nag
  }
}
function markCoached() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // ignore
  }
}

interface Step {
  title: string;
  body: string;
}

const STEPS: Step[] = [
  { title: "1 · Pick the Speed limits tool", body: "Click the speed-sign icon on the left (or press P)." },
  { title: "2 · Click a road", body: "Pick any road. A slow-posted block drags everyone behind it down, so try the busy ones." },
  { title: "3 · Choose a better limit", body: "Tap a higher number. It changes while the cars keep driving." },
  { title: "4 · Watch what happens", body: "In about 20 seconds the game tells you whether it helped. Your changes are listed on the right." },
];

/**
 * A one-time walkthrough of the very first fix in a Traffic Manager level: it names the next thing to do and ticks
 * along as the player does it, rather than front-loading a card tour. Disappears for good once it has seen one
 * measured result (or when dismissed).
 */
export default function CoachBar() {
  const buildLocked = useEditorStore((s) => s.buildLocked);
  const scenarioActive = useEditorStore((s) => s.activeScenarioId !== null);
  const edits = useEditLog();

  const [coached, setCoached] = useState(true); // assume done until the client has looked at storage
  const [usedSpeedTool, setUsedSpeedTool] = useState(false);
  const [pickedRoad, setPickedRoad] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setCoached(alreadyCoached()));
    return () => cancelAnimationFrame(id);
  }, []);

  // The store tells us when the player does the first two things.
  useEffect(
    () =>
      useEditorStore.subscribe((s) => {
        if (s.tool === "speed") setUsedSpeedTool(true);
        if (s.tool === "speed" && s.selection?.kind === "edge") setPickedRoad(true);
      }),
    []
  );

  const edited = edits.length > 0;
  const measured = edits.some((e) => e.delta !== null);

  useEffect(() => {
    if (measured && !coached) markCoached();
  }, [measured, coached]);

  if (coached || !buildLocked || !scenarioActive) return null;

  const current = measured ? 4 : edited ? 3 : pickedRoad ? 2 : usedSpeedTool ? 1 : 0;
  const step = STEPS[Math.min(current, STEPS.length - 1)];
  const finished = measured;

  return (
    <div className="pointer-events-auto absolute bottom-20 left-1/2 z-30 w-[min(32rem,92vw)] -translate-x-1/2">
      <div className="hud-panel flex items-start gap-3 rounded-2xl border-violet-500 p-3.5">
        <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${i < current || finished ? "bg-emerald-500" : i === current ? "bg-fuchsia-500" : "bg-black/15"}`}
            />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm font-extrabold uppercase text-[#241b3d]">
            {finished ? "🎉 You just made your first fix!" : step.title}
          </div>
          <p className="mt-0.5 text-xs font-semibold leading-snug text-zinc-600">
            {finished
              ? "Now try Lane arrows (L) and Junctions (J) too. Between them, every fault in this city has a fix."
              : step.body}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            markCoached();
            setCoached(true);
          }}
          className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold text-zinc-500 hover:bg-black/5 hover:text-zinc-800"
        >
          {finished ? "Got it" : "Skip"}
        </button>
      </div>
    </div>
  );
}
