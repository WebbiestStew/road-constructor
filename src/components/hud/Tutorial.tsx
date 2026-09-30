"use client";

import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import { hasSeenTutorial, markTutorialSeen, subscribeOpenTutorial } from "@/lib/tutorial";
import { IconDraw, IconJunction, IconLanes, IconRoad, IconSpeedSign, IconWarning } from "./icons";

interface Step {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: IconRoad,
    title: "Welcome to Road Constructor 🛣️",
    body: "The city is already built. Your job is to make the traffic work. This quick tour covers the tools; you can reopen it anytime from the ? button.",
  },
  {
    icon: IconWarning,
    title: "Find the jam",
    body: "Move around with WASD (Shift to go faster, Q/E to rotate). Traffic runs live. Flashing markers show roads that are badly jammed, and the Heatmap button colors every road by how fast it's really moving. Fix the worst spot first.",
  },
  {
    icon: IconLanes,
    title: "Lane arrows (L)",
    body: "Click a road that splits at a junction and choose which lanes can turn left, go straight or turn right. A lane that only turns left can starve everyone going straight.",
  },
  {
    icon: IconSpeedSign,
    title: "Speed limits (P)",
    body: "Pick a road and post a limit. Drivers cruise near it, so one slow stretch backs up the whole road behind it. Tick \"whole road\" to change it end to end.",
  },
  {
    icon: IconJunction,
    title: "Junctions (J)",
    body: "Switch a junction between priority and a traffic light, and tune how long each direction stays green. Everything updates while cars are driving — no restarts.",
  },
  {
    icon: IconDraw,
    title: "Sandbox: build your own",
    body: "From the campaign menu you can also build from scratch with a budget: draw roads, mark entries and destinations, then open to traffic and try your own fix.",
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
            {isLast ? "Let's go! 🚦" : "Next ▶"}
          </button>
        </div>
      </div>
    </div>
  );
}

