"use client";

import { useState } from "react";
import { SCENARIOS } from "@/sim/scenarios";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import { IconClock, IconFlag } from "./icons";

function formatMMSS(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function ScenarioPicker({
  onStart,
  onClose,
  hasActiveScenario,
  onFreeBuild,
}: {
  onStart: (id: string) => void;
  onClose: () => void;
  hasActiveScenario: boolean;
  onFreeBuild: () => void;
}) {
  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="hud-panel flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-extrabold text-[#241b3d]">Pick a scenario 🎯</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-xs font-bold text-zinc-500 hover:text-zinc-800"
          >
            Close
          </button>
        </div>

        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onStart(s.id)}
            className="flex flex-col gap-1 rounded-xl border-2 border-transparent bg-black/[0.03] p-3 text-left transition hover:border-violet-400 hover:bg-violet-50 active:scale-[0.99]"
          >
            <span className="font-display text-sm font-bold text-[#241b3d]">{s.name}</span>
            <span className="text-xs font-semibold text-violet-600">{s.tagline}</span>
            <span className="text-[11px] leading-snug text-zinc-500">{s.briefing}</span>
            <span className="mt-1 flex gap-3 text-[10.5px] font-bold uppercase tracking-wide text-zinc-400">
              <span>⏱ {s.durationS}s</span>
              <span>💰 ${(s.startingBudget / 1000).toFixed(0)}k</span>
            </span>
          </button>
        ))}

        {hasActiveScenario && (
          <button
            type="button"
            onClick={onFreeBuild}
            className="self-center text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-700"
          >
            Leave campaign, go free-build
          </button>
        )}
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-black/[0.03] px-3 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="font-display text-sm font-bold text-[#241b3d] tabular-nums">{value}</span>
    </div>
  );
}

function ResultsModal({ runner }: { runner: UseScenarioRunnerReturn }) {
  const { scenario, results } = runner;
  if (!scenario || !results) return null;

  const grade = results.score >= 85 ? "S" : results.score >= 70 ? "A" : results.score >= 50 ? "B" : results.score >= 30 ? "C" : "D";
  const isLast = SCENARIOS[SCENARIOS.length - 1].id === scenario.id;

  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div className="hud-panel flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl p-6 text-center">
        <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">{scenario.name} — time is up!</span>
        <div className="hover-wiggle flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-pink-500 text-4xl font-black text-white shadow-lg">
          {grade}
        </div>
        <span className="font-display text-2xl font-extrabold text-[#241b3d]">{results.score} / 100</span>

        <div className="flex w-full flex-col gap-1.5">
          <StatRow label="Avg speed" value={`${results.avgSpeedMph.toFixed(0)} mph`} />
          <StatRow label="Throughput" value={`${results.throughputPerMinute.toFixed(0)} /min`} />
          <StatRow label="Contracts met" value={`${results.contractsMet} / ${results.contractsTotal}`} />
          <StatRow label="Budget left" value={`$${Math.max(0, results.budgetRemaining).toLocaleString()}`} />
        </div>

        <div className="mt-2 flex w-full gap-2">
          <button
            type="button"
            onClick={runner.retry}
            className="flex-1 rounded-xl bg-gradient-to-br from-sky-400 to-blue-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            Retry ↻
          </button>
          <button
            type="button"
            onClick={runner.nextScenario}
            className="flex-1 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            {isLast ? "Finish 🏆" : "Next ▶"}
          </button>
        </div>
        <button
          type="button"
          onClick={runner.exitToFreeBuild}
          className="text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-700"
        >
          Free-build this network
        </button>
      </div>
    </div>
  );
}

export default function ScenarioHud({ runner }: { runner: UseScenarioRunnerReturn }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { scenario } = runner;

  return (
    <>
      <div className="pointer-events-auto absolute bottom-4 left-4 z-20">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="hud-panel flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-bold text-[#241b3d] transition hover:brightness-105 active:scale-95"
        >
          {scenario ? (
            <>
              <IconClock className="h-3.5 w-3.5 text-violet-600" />
              {scenario.name} · {formatMMSS(runner.remainingS)}
            </>
          ) : (
            <>
              <IconFlag className="h-3.5 w-3.5 text-violet-600" />
              Campaign
            </>
          )}
        </button>
      </div>

      {pickerOpen && !runner.results && (
        <ScenarioPicker
          hasActiveScenario={!!scenario}
          onStart={(id) => {
            const def = SCENARIOS.find((s) => s.id === id);
            if (def) runner.startScenario(def);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
          onFreeBuild={() => {
            runner.exitToFreeBuild();
            setPickerOpen(false);
          }}
        />
      )}

      {runner.results && <ResultsModal runner={runner} />}
    </>
  );
}
