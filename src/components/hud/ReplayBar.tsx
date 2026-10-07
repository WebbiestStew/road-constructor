"use client";

import { useEffect, useRef, useState } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { leaveReplay, restartReplay } from "@/lib/replayPlayer";
import { startFlyover } from "@/lib/cinematic";
import { recordClip } from "@/lib/photoMode";
import { shareOrDownload } from "@/lib/shareCard";
import { pushToast } from "@/lib/toast";

const SPEEDS = [1, 2, 5, 10];
const KIND_ICON: Record<string, string> = { combo: "🌊", clear: "🚧", ambulance: "🚑", crash: "💥", jam: "🚦" };
/** How far ahead of a highlight the replay starts, so the lead-up is in the clip. */
const LEAD_IN_S = 4;
const CLIP_S = 8;

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
  const { setRunning, setSpeedMultiplier } = sim;
  // Jumping to a moment: play from the top (or on from here) at full speed until just before it, then at normal speed, and record if asked.
  const [seek, setSeek] = useState<{ to: number; back: number; clip: boolean } | null>(null);
  const clipping = useRef(false);
  const handled = useRef<typeof seek>(null);

  useEffect(() => {
    if (!seek || !live || simTime < seek.to || handled.current === seek) return;
    handled.current = seek;
    const { back, clip } = seek;
    requestAnimationFrame(() => setSeek(null));
    setSpeedMultiplier(back);
    if (clip && !clipping.current) {
      clipping.current = true;
      pushToast(`🎥 Recording ${CLIP_S} seconds…`, "info");
      void recordClip(CLIP_S).then(async (result) => {
        clipping.current = false;
        if (!result) {
          pushToast("This browser can't record clips. Try Chrome or Edge", "bad");
          return;
        }
        const how = await shareOrDownload(result.blob, `road-constructor-highlight-${Date.now()}.${result.ext}`, "A moment from my run in Road Constructor");
        pushToast(how === "shared" ? "🎥 Clip shared" : "🎥 Clip saved to your downloads", "good");
      });
    }
  }, [seek, live, simTime, setSpeedMultiplier]);

  const jump = (at: number, clip: boolean) => {
    const to = Math.max(0, at - LEAD_IN_S);
    if (!live || simTime > to) restartReplay(sim);
    setSeek({ to, back: sim.speedMultiplier > 10 ? 1 : sim.speedMultiplier, clip });
    setSpeedMultiplier(40);
    setRunning(true);
  };

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
          {seek && <span className="text-[10.5px] font-bold text-violet-600">⏩ jumping…</span>}
          <span className="ml-auto text-[10.5px] font-semibold text-zinc-500">
            {meta.stars > 0 ? `${"★".repeat(meta.stars)}${"☆".repeat(3 - meta.stars)} · ` : ""}
            {meta.summary}
          </span>
        </div>
        {meta.highlights && meta.highlights.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-t border-black/10 pt-1.5">
            <span className="text-[10px] font-extrabold uppercase tracking-wide text-zinc-400">Highlights</span>
            {meta.highlights.map((h) => (
              <span key={`${h.at}-${h.kind}`} className="flex items-center overflow-hidden rounded-full bg-black/5 text-[11px] font-bold text-zinc-700">
                <button type="button" onClick={() => jump(h.at, false)} title={`Jump to ${mmss(h.at)}`} className="px-2 py-0.5 hover:bg-black/10">
                  {KIND_ICON[h.kind] ?? "⭐"} {mmss(h.at)} {h.label}
                </button>
                <button type="button" onClick={() => jump(h.at, true)} title={`Record an ${CLIP_S}-second clip of this`} aria-label="Record a clip" className="border-l border-black/10 px-1.5 py-0.5 hover:bg-black/10">
                  🎥
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
