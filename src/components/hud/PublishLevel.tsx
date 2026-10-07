"use client";

import { useEffect, useRef, useState } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import { challengerName, encodeChallenge, onPublishRequest, setActiveChallenge } from "@/lib/challenge";
import { MEASURE_RUN_S, measureCity, type Measurement, type SeedProgress } from "@/lib/measureLevel";
import { buildPublishedScenario } from "@/sim/scenarios";
import { useEditorStore } from "@/state/editorStore";
import { pushToast } from "@/lib/toast";

type Phase = "closed" | "ready" | "measuring" | "done" | "failed";

const TWO_STAR = 1.07;
const THREE_STAR = 1.12;
/** Below this many vehicles in five minutes a city has too little traffic to set star lines from. */
const MIN_BASELINE = 30;
/** More than this much disagreement between seeds makes the star lines unreliable. */
const MAX_SPREAD = 0.15;
const LONG_LINK = 45_000;

/**
 * Publish my city as a level: runs the city untouched in a few spare simulations to find out what it moves, sets the
 * star lines from that (the same way the real-city levels are set), and hands back a link. Whoever opens it plays a
 * locked city and has to beat the unchanged result. Renders only while open.
 */
export default function PublishLevel({ sim, runner }: { sim: UseTrafficSimulationReturn; runner: UseScenarioRunnerReturn }) {
  const [phase, setPhase] = useState<Phase>("closed");
  const [name, setName] = useState("");
  const [seeds, setSeeds] = useState<SeedProgress[]>([]);
  const [result, setResult] = useState<Measurement | null>(null);
  const [error, setError] = useState("");
  const [linkLength, setLinkLength] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const wasRunning = useRef(false);
  const { running, setRunning } = sim;

  useEffect(
    () =>
      onPublishRequest(() => {
        const s = useEditorStore.getState();
        if (s.replay) {
          pushToast("Leave the replay first", "alert");
          return;
        }
        const hasEntry = s.edges.some((e) => e.zone?.type === "entry");
        const hasDest = s.edges.some((e) => e.zone?.type === "destination");
        if (!hasEntry || !hasDest) {
          pushToast("Add at least one entry and one destination first (Zone tool), so there's traffic to measure", "alert");
          return;
        }
        setName((n) => n || `${challengerName()}'s city`);
        setResult(null);
        setError("");
        setPhase("ready");
      }),
    []
  );

  const close = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("closed");
    if (wasRunning.current) {
      wasRunning.current = false;
      setRunning(true);
    }
  };

  const measure = async () => {
    const s = useEditorStore.getState();
    wasRunning.current = running;
    if (running) setRunning(false);
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("measuring");
    try {
      const m = await measureCity({ nodes: s.nodes, edges: s.edges }, s.trafficMix, setSeeds, controller.signal);
      if (m.baseline < MIN_BASELINE) {
        setError(`Only ${m.baseline} vehicles got through in five minutes. A level needs real traffic: connect the entries to the destinations and check nothing is blocked.`);
        setPhase("failed");
        return;
      }
      setResult(m);
      setPhase("done");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "The measurement failed");
      setPhase("failed");
    } finally {
      abortRef.current = null;
    }
  };

  const link = async (): Promise<string | null> => {
    if (!result) return null;
    const s = useEditorStore.getState();
    const url = await encodeChallenge({
      kind: "published",
      name: name.trim().slice(0, 40) || "A city",
      network: { nodes: s.nodes, edges: s.edges },
      from: challengerName(),
      target: Math.ceil(result.baseline * THREE_STAR),
      baseline: result.baseline,
      delayShare: result.delayShare > 0 ? +result.delayShare.toFixed(3) : undefined,
      queueFt: result.queueFt,
      bus: s.trafficMix.bus || undefined,
      bike: s.trafficMix.bike || undefined,
    });
    setLinkLength(url.length);
    return url;
  };

  const copy = async () => {
    const url = await link();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      pushToast("📤 Level link copied. Whoever opens it plays your city against its unchanged score", "good");
    } catch {
      window.prompt("Copy this level link:", url);
    }
  };

  const playIt = () => {
    if (!result) return;
    const s = useEditorStore.getState();
    const key = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const def = buildPublishedScenario({
      key,
      name: name.trim().slice(0, 40) || "A city",
      network: { nodes: s.nodes, edges: s.edges },
      baseline: result.baseline,
      service: result.delayShare > 0 ? { delayShare: result.delayShare, queueFt: result.queueFt } : undefined,
      mix: s.trafficMix,
    });
    wasRunning.current = false;
    setPhase("closed");
    runner.startScenario(def);
    setActiveChallenge(null);
  };

  if (phase === "closed") return null;
  const two = result ? Math.ceil(result.baseline * TWO_STAR) : 0;
  const three = result ? Math.ceil(result.baseline * THREE_STAR) : 0;
  const overall = seeds.length > 0 ? seeds.reduce((a, b) => a + b.progress, 0) / seeds.length : 0;

  return (
    <div className="pointer-events-auto fixed inset-0 z-[63] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Publish this city as a level">
      <div className="hud-panel flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-3xl p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-extrabold uppercase text-[#241b3d]">📤 Publish as a level</h2>
          <button type="button" onClick={close} className="rounded-full bg-black/5 px-3 py-1.5 text-xs font-bold text-zinc-700 hover:bg-black/10">
            {phase === "measuring" ? "Cancel" : "Close"}
          </button>
        </div>

        {phase === "ready" && (
          <>
            <p className="text-[12.5px] font-semibold leading-snug text-zinc-600">
              Your city becomes a level. We run it untouched in {seeds.length || 3} spare simulations to see what it moves, and set the star lines from that, so a friend has to genuinely beat the unchanged city. Takes about {Math.round(MEASURE_RUN_S / 20)}-{Math.round(MEASURE_RUN_S / 8)} seconds.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-zinc-400">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 40))}
                className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-[#241b3d] outline-none focus:border-violet-400"
              />
            </label>
            <button type="button" onClick={() => void measure()} className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 py-2.5 text-sm font-bold text-white shadow-sm hover:brightness-110 active:scale-95">
              Measure and publish
            </button>
          </>
        )}

        {phase === "measuring" && (
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] font-semibold text-zinc-600">Running your city, untouched… {Math.round(overall * 100)}%</p>
            {seeds.map((s, i) => (
              <div key={s.seed} className="flex items-center gap-2">
                <span className="w-16 text-[11px] font-bold text-zinc-500">Run {i + 1}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-black/10">
                  <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width]" style={{ width: `${s.progress * 100}%` }} />
                </div>
                <span className="w-8 text-right text-[11px] font-bold tabular-nums text-zinc-400">{s.done ? "✓" : `${Math.round(s.progress * 100)}%`}</span>
              </div>
            ))}
          </div>
        )}

        {phase === "failed" && <p className="rounded-xl bg-red-50 px-3 py-2 text-[12.5px] font-semibold text-red-700">{error}</p>}

        {phase === "done" && result && (
          <>
            <div className="flex flex-col gap-1 rounded-2xl bg-black/[0.04] p-3 text-[12.5px] font-semibold text-zinc-700">
              <span>
                The unchanged city moves <b className="font-display text-base text-[#241b3d]">{result.baseline}</b> vehicles in five minutes
                <span className="text-zinc-500"> ({result.trips.join(", ")} over the runs)</span>
              </span>
              <span>
                ★★ at <b>{two}</b> · ★★★ at <b>{three}</b>
              </span>
              {result.delayShare > 0 && (
                <span className="text-[11.5px] text-zinc-500">
                  Trips take {Math.round(result.delayShare * 100)}% longer than an empty road, and the longest queue is {result.queueFt} ft: the service medals ask for 10% and 15% better.
                </span>
              )}
            </div>
            {result.spread > MAX_SPREAD && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-800">
                The runs disagreed by {Math.round(result.spread * 100)}%: this city is very sensitive to luck, so stars will be hard to earn reliably. Simpler demand tends to settle it.
              </p>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => void copy()} className="flex-1 rounded-xl bg-gradient-to-br from-rose-400 to-orange-500 py-2.5 text-xs font-bold text-white shadow-sm hover:brightness-110 active:scale-95">
                📋 Copy the level link
              </button>
              <button type="button" onClick={playIt} className="flex-1 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 py-2.5 text-xs font-bold text-white shadow-sm hover:brightness-110 active:scale-95">
                ▶ Play it
              </button>
            </div>
            {linkLength > LONG_LINK && (
              <p className="text-[11px] font-semibold text-amber-700">That link is long ({Math.round(linkLength / 1000)} KB). Some chat apps cut links off: a smaller city travels better.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
