"use client";

import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import { hasSeenTutorial, markTutorialSeen, subscribeOpenTutorial } from "@/lib/tutorial";
import { IconCoin, IconDraw, IconFlag, IconPlay, IconRoad, IconZone } from "./icons";

interface Step {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: IconRoad,
    title: "Welcome to Road Constructor 🛣️",
    body: "Build a road network, open it to traffic, and see if it actually works. This quick tour covers the basics — you can reopen it anytime from the ? button.",
  },
  {
    icon: IconDraw,
    title: "Draw roads",
    body: "Pick the Draw tool, click to start a road, click again to keep extending it. Click an existing road to tap a junction into it. Press Escape to stop the current chain.",
  },
  {
    icon: IconZone,
    title: "Mark entries & destinations",
    body: "Switch to the Zone tool and click a road to cycle it: none → Entry (cars spawn here) → Destination (cars head here, with a target speed) → none.",
  },
  {
    icon: IconCoin,
    title: "Mind the budget",
    body: "Every road costs money based on class, lanes, and length. Demolishing a road refunds half its cost — use the Delete tool if you need to rethink something.",
  },
  {
    icon: IconPlay,
    title: "Open to Traffic",
    body: "Hit the green play button to simulate. Watch cars flow, adjust entry demand, and check whether each destination is hitting its target speed.",
  },
  {
    icon: IconFlag,
    title: "More to explore",
    body: "Undo/redo (Ctrl+Z), export/import, a Heatmap toggle, and a Ride Along chase camera are in the top bar. While traffic's open, click any road or junction for live LOS/speed stats — plus timed Campaign scenarios with scoring.",
  },
];

function ProgressDots({ count, active }: { count: number; active: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === active ? "w-5 bg-gradient-to-r from-violet-500 to-fuchsia-600" : "w-1.5 bg-black/15"
          }`}
        />
      ))}
    </div>
  );
}

export default function Tutorial() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (!hasSeenTutorial()) {
        setStep(0);
        setOpen(true);
      }
    });
    const unsubscribe = subscribeOpenTutorial(() => {
      setStep(0);
      setOpen(true);
    });
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);

  if (!open) return null;

  const close = () => {
    markTutorialSeen();
    setOpen(false);
  };

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  const Icon = current.icon;

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="hud-panel flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl p-6 text-center">
        <span className="hover-wiggle flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-lg">
          <Icon className="h-8 w-8" />
        </span>
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-lg font-extrabold text-[#241b3d]">{current.title}</h2>
          <p className="text-[13px] leading-snug text-zinc-600">{current.body}</p>
        </div>

        <ProgressDots count={STEPS.length} active={step} />

        <div className="mt-1 flex w-full items-center gap-2">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="flex-1 rounded-xl bg-black/5 px-3 py-2 text-xs font-bold text-zinc-600 transition hover:bg-black/10 active:scale-95"
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={close}
              className="flex-1 rounded-xl bg-black/5 px-3 py-2 text-xs font-bold text-zinc-600 transition hover:bg-black/10 active:scale-95"
            >
              Skip
            </button>
          )}
          <button
            type="button"
            onClick={() => (isLast ? close() : setStep((s) => s + 1))}
            className="flex-1 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            {isLast ? "Let's build! 🚧" : "Next ▶"}
          </button>
        </div>
      </div>
    </div>
  );
}

