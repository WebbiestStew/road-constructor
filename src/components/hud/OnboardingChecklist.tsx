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
 * A lightweight, non-blocking 3-step checklist for first-time players —
 * unlike Tutorial.tsx's modal tour, this stays out of the way and tracks
 * real progress live, so it disappears the moment the player has actually
 * done the thing rather than requiring an explicit "next" click.
 */
export default function OnboardingChecklist() {
  const mode = useEditorStore((s) => s.mode);
  const edges = useEditorStore((s) => s.edges);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (!hasSeenOnboarding()) setVisible(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

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
  if (mode !== "build" && !allDone) return null;

  const dismiss = () => {
    markOnboardingSeen();
    setVisible(false);
  };

  return (
    <div className="animate-pop pointer-events-auto absolute left-4 top-20 z-20 w-64">
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

        <div className="flex flex-col gap-2">
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
