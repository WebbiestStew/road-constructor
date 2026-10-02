"use client";

import { useMemo } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { getScenarioById } from "@/sim/scenarios";

export const GUIDED_LEVEL_ID = "first-shift";

interface TourStep {
  title: string;
  body: string;
  done: boolean;
}

/**
 * The step-by-step guide for the First Shift level. It names the next thing to do, in order, and ticks each one off
 * by looking at what the player has actually changed, so it never gets out of step with what's on screen.
 */
export default function GuidedTour({ sim }: { sim: UseTrafficSimulationReturn }) {
  const activeId = useEditorStore((s) => s.activeScenarioId);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const tool = useEditorStore((s) => s.tool);

  // What the level started with: which roads were posted slow and which lights were frantic.
  const initial = useMemo(() => {
    const def = getScenarioById(GUIDED_LEVEL_ID);
    const slow = new Set(def?.startingNetwork.edges.filter((e) => e.speedLimitMph <= 15).map((e) => e.id));
    const angry = new Set(
      def?.startingNetwork.nodes.filter((n) => n.control?.type === "signal" && n.control.greenDurationS <= 4).map((n) => n.id)
    );
    return { slow, angry };
  }, []);

  if (activeId !== GUIDED_LEVEL_ID) return null;

  const slowLeft = edges.some((e) => initial.slow.has(e.id) && e.speedLimitMph <= 15);
  const angryLeft = nodes.some((n) => initial.angry.has(n.id) && n.control?.type === "signal" && n.control.greenDurationS <= 4);
  const crossed = edges.some((e) => e.jaywalkers && e.crosswalk);
  const watched = sim.metrics.simTime > 10;

  const steps: TourStep[] = [
    { title: "Watch the street", body: "Cars are piling up. Flashing markers show where. Give it ten seconds, then let's fix it.", done: watched },
    {
      title: "Fix the slow block",
      body: tool === "speed" ? "Click the stretch where cars crawl, then pick a higher number." : "Pick the Speed limits tool (the sign icon, or press P). One block is posted 15 mph.",
      done: !slowLeft,
    },
    {
      title: "Calm the angry light",
      body: tool === "junction" ? "Click a glowing junction, then drag Green time up. One light flips every few seconds." : "Pick the Junctions tool (press J). One traffic light changes far too fast.",
      done: !angryLeft,
    },
    {
      title: "Give the kids a crossing",
      body: tool === "street" ? "Click the first block of road and press Add a crossing here." : "Pick the Streets tool (press K). Kids cross the first block with no crossing and step into traffic.",
      done: crossed,
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  const finished = current === -1;
  const step = steps[Math.max(0, current)];

  return (
    <div className="pointer-events-none absolute bottom-20 left-1/2 z-30 w-[min(30rem,92vw)] -translate-x-1/2 max-md:bottom-[5rem]">
      <div className="hud-panel flex items-start gap-3 rounded-2xl border-violet-500 p-3.5">
        <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
          {steps.map((s, i) => (
            <span key={i} className={`h-1.5 w-1.5 rounded-full ${s.done ? "bg-emerald-500" : i === current ? "bg-fuchsia-500" : "bg-black/15"}`} />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm font-extrabold uppercase text-[#241b3d]">
            {finished ? "🎉 That's all three fixes" : `${current + 1} · ${step.title}`}
          </div>
          <p className="mt-0.5 text-xs font-semibold leading-snug text-zinc-600">
            {finished ? "Keep the traffic flowing until the clock runs out. Your stars depend on how many vehicles get through." : step.body}
          </p>
        </div>
      </div>
    </div>
  );
}
