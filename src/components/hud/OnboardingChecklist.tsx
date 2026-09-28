"use client";

import { useEffect, useState } from "react";
import { useEditorStore } from "@/state/editorStore";
import { hasSeenOnboarding, markOnboardingSeen } from "@/lib/onboarding";
import { IconCheck, IconClose } from "./icons";

interface ChecklistStep {
  title: string;
  body: string;
  done: boolean;
}

/**
 * A lightweight, non-blocking 5-step checklist for first-time players —
 * unlike Tutorial.tsx's modal tour, this stays out of the way and tracks
 * real progress live, so it disappears the moment the player has actually
 * done the thing rather than requiring an explicit "next" click. The last
 * two steps only become completable once traffic is open, so — unlike the
 * original 3-step version — this stays visible in Simulate mode too rather
 * than hiding until everything's done.
 */
export default function OnboardingChecklist() {
  const mode = useEditorStore((s) => s.mode);
  const edges = useEditorStore((s) => s.edges);
  const selection = useEditorStore((s) => s.selection);
  const heatmapEnabled = useEditorStore((s) => s.heatmapEnabled);
  const rideAlongActive = useEditorStore((s) => s.rideAlongActive);
  const [visible, setVisible] = useState(false);
  const [hasInspectedLive, setHasInspectedLive] = useState(false);
  const [hasTriedHeatmapOrRideAlong, setHasTriedHeatmapOrRideAlong] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (!hasSeenOnboarding()) setVisible(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // These two only make sense once traffic is running, so they latch true
  // permanently the first time they happen rather than tracking current
  // state — otherwise deselecting or re-toggling would "undo" the
  // checkmark. Adjusted directly during render, guarded by a stored
  // previous value (React's documented pattern for deriving state from a
  // changed value), rather than in an effect or a ref — refs can't be
  // read or written during render either.
  const [prevSelection, setPrevSelection] = useState(selection);
  if (selection !== prevSelection) {
    setPrevSelection(selection);
    if (mode === "simulate" && selection) setHasInspectedLive(true);
  }
  const heatmapOrRideAlongNow = heatmapEnabled || rideAlongActive;
  const [prevHeatmapOrRideAlong, setPrevHeatmapOrRideAlong] = useState(heatmapOrRideAlongNow);
  if (heatmapOrRideAlongNow !== prevHeatmapOrRideAlong) {
    setPrevHeatmapOrRideAlong(heatmapOrRideAlongNow);
    if (heatmapOrRideAlongNow) setHasTriedHeatmapOrRideAlong(true);
  }

  const hasHighway = edges.some((e) => e.roadClassId === "highway");
  const hasEntry = edges.some((e) => e.zone?.type === "entry");
  const hasDestination = edges.some((e) => e.zone?.type === "destination");
  const hasOpenedTraffic = mode === "simulate";

  const steps: ChecklistStep[] = [
    {
      title: "Draw a 4-lane highway",
      body: "Pick Highway from the road-type row and connect two points.",
      done: hasHighway,
    },
    {
      title: "Set an entry & destination zone",
      body: "Switch to Zone, then click a road twice to cycle Entry → Destination.",
      done: hasEntry && hasDestination,
    },
    {
      title: "Hit Open to Traffic",
      body: "Top-left toggle — watch your network handle real cars.",
      done: hasOpenedTraffic,
    },
    {
      title: "Inspect live traffic",
      body: "While traffic's open, click a road or junction for live LOS, speed, and capacity stats.",
      done: hasInspectedLive,
    },
    {
      title: "Try Heatmap or Ride Along",
      body: "Heatmap colors roads by congestion; Ride Along chases one car down the road.",
      done: hasTriedHeatmapOrRideAlong,
    },
  ];

  const allDone = steps.every((s) => s.done);

  useEffect(() => {
    if (allDone && visible) {
      markOnboardingSeen();
      const t = setTimeout(() => setVisible(false), 1400);
      return () => clearTimeout(t);
    }
  }, [allDone, visible]);

  if (!visible) return null;

  const dismiss = () => {
    markOnboardingSeen();
    setVisible(false);
  };

  return (
    <div className="animate-pop pointer-events-auto absolute left-4 top-60 z-20 w-64 max-w-[calc(50vw-1.5rem)] lg:top-20">
      <div className="hud-panel flex flex-col gap-2.5 rounded-2xl p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-800">Quick start 🚧</span>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss checklist"
            className="text-zinc-400 hover:text-zinc-700"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex max-h-[32vh] flex-col gap-2 overflow-y-auto lg:max-h-none lg:overflow-visible">
          {steps.map((step, i) => (
            <div key={step.title} className="flex items-start gap-2">
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition ${
                  step.done
                    ? "bg-gradient-to-br from-emerald-400 to-teal-500 text-white"
                    : "bg-black/5 text-zinc-500"
                }`}
              >
                {step.done ? <IconCheck className="h-2.5 w-2.5" /> : i + 1}
              </span>
              <div className="flex flex-col">
                <span
                  className={`text-[11px] font-semibold leading-snug ${
                    step.done ? "text-zinc-400 line-through" : "text-zinc-800"
                  }`}
                >
                  {step.title}
                </span>
                {!step.done && (
                  <span className="text-[10px] leading-snug text-zinc-500">{step.body}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {allDone && (
          <p className="text-center text-[11px] font-semibold text-emerald-600">You&rsquo;re all set! 🎉</p>
        )}
      </div>
    </div>
  );
}
