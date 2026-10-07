"use client";

import { useEffect } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { leaveReplay, restartReplay } from "@/lib/replayPlayer";
import { startFlyover } from "@/lib/cinematic";

const SPEEDS = [1, 2, 5, 10];

function mmss(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, "0")}`;
}

/**
 * The replay's controls: where it is in the run, how fast it plays, restart, the drone flyover over it, and the way
 * out (which puts the player's own city back). Also shows the player's tweaks to roads and signals on the map as the
 * replay reaches them, and stops the clock when the run ends. Renders nothing outside a replay.
 */
export default function ReplayBar({ sim }: { sim: UseTrafficSimulationReturn }) {
  const replay = useEditorStore((s) => s.replay);
  const advance = useEditorStore((s) => s.advanceReplay);
  // Until the worker reports the replay's own run, the clock shown is the run before it.
  const live = sim.metrics.replayLive;
  const simTime = live ? sim.metrics.simTime : 0;
  const duration = replay?.meta.durationS ?? 0;
  const finished = !!replay && live && simTime >= duration - 0.2;
  const { setRunning } = sim;

  useEffect(() => {
    if (replay) advance(simTime);
  }, [replay, simTime, advance]);

  useEffect(() => {
    if (finished) setRunning(false);
  }, [finished, setRunning]);

  if (!replay) return null;
  const { meta } = replay;
  const progress = Math.min(1, Math.max(0, simTime / Math.max(1, duration)));
  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 z-30 w-[min(34rem,calc(100vw-1rem))] -translate-x-1/2">
      <div className="hud-panel flex flex-col gap-1.5 rounded-2xl px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-display text-xs font-extrabold uppercase text-[#241b3d]">
            🎞️ Replay · {meta.name}
          </span>
          <button
            type="button"
            onClick={() => leaveReplay(sim)}
            className="shrink-0 rounded-full bg-black/5 px-3 py-1 text-[11px] font-bold text-zinc-700 hover:bg-black/10"
          >
            ✕ Exit
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-10 text-[11px] font-bold tabular-nums text-zinc-500">{mmss(simTime)}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500" style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="w-10 text-right text-[11px] font-bold tabular-nums text-zinc-500">{mmss(duration)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => (finished ? restartReplay(sim) : setRunning(!sim.running))}
            className="rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 px-3 py-1 text-[11px] font-bold text-white shadow-sm hover:brightness-110 active:scale-95"
          >
            {finished ? "↻ Again" : sim.running ? "⏸ Pause" : "▶ Play"}
          </button>
          <button type="button" onClick={() => restartReplay(sim)} className="rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold text-zinc-700 hover:bg-black/10">
            ⏮ Restart
          </button>
          <div className="flex items-center gap-0.5 rounded-full bg-black/5 p-0.5">
            {SPEEDS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={sim.speedMultiplier === v}
                onClick={() => sim.setSpeedMultiplier(v)}
                className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${sim.speedMultiplier === v ? "bg-white text-[#241b3d] shadow" : "text-zinc-500 hover:text-zinc-800"}`}
              >
                {v}×
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              sim.setRunning(true);
              startFlyover({ name: meta.scenarioName, stars: meta.stars, summary: meta.summary, makeLink: null });
            }}
            className="rounded-full bg-gradient-to-br from-indigo-500 to-sky-500 px-3 py-1 text-[11px] font-bold text-white shadow-sm hover:brightness-110 active:scale-95"
          >
            🎬 Flyover
          </button>
          <span className="ml-auto text-[10.5px] font-semibold text-zinc-500">
            {meta.stars > 0 ? `${"★".repeat(meta.stars)}${"☆".repeat(3 - meta.stars)} · ` : ""}
            {meta.summary}
          </span>
        </div>
      </div>
    </div>
  );
}
