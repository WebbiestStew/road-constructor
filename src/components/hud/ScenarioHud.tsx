"use client";

import { useEffect, useState } from "react";
import { CHALLENGE_PREFIX, DAILY_PREFIX, SCENARIOS, STORY_ARC, buildDailyScenario, getScenarioById, type ScenarioDef } from "@/sim/scenarios";
import { dateKey, useDaily } from "@/lib/daily";
import { isSandboxBudget, useEditorStore } from "@/state/editorStore";
import { totalStars, useProgress } from "@/lib/progress";
import { pushToast } from "@/lib/toast";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import { playFailTone, playVictoryFanfare } from "@/lib/sound";
import { IconClock, IconFlag, IconStar } from "./icons";
import PlaceSearch from "./PlaceSearch";
import DailyBoard from "./DailyBoard";
import ServiceReportCard from "./ServiceReportCard";
import CareerCard from "./CareerCard";
import { useCareer } from "@/lib/career";
import { MEDAL_META } from "@/lib/serviceReport";
import { makeShareCard, shareOrDownload } from "@/lib/shareCard";
import { startFlyover } from "@/lib/cinematic";
import { saveReplay } from "@/lib/replays";
import { openSaves } from "@/lib/savesMenu";
import { challengerName, encodeChallenge, setActiveChallenge, useActiveChallenge } from "@/lib/challenge";
import type { NetworkSnapshot } from "@/sim/types";
import type { SceneryData } from "@/sim/osm/scenery";

function formatMMSS(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Stars earned in the story chapters before this one (they open the later chapters). */
function storyStarsBefore(chapter: number, progress: Record<string, number>): number {
  return SCENARIOS.filter((d) => d.story && d.story.chapter < chapter).reduce((n, d) => n + (progress[d.id] ?? 0), 0);
}

function ScenarioCard({ s, onStart }: { s: ScenarioDef; onStart: (id: string) => void }) {
  const progress = useProgress();
  const stars = progress[s.id] ?? 0;
  const medals = useCareer().medals[s.id] ?? [];
  const need = s.story?.requiresStars ?? 0;
  const have = s.story ? storyStarsBefore(s.story.chapter, progress) : 0;
  const locked = need > have;
  return (
    <button
      type="button"
      disabled={locked}
      onClick={() => onStart(s.id)}
      className="flex flex-col gap-1 rounded-xl border-2 border-transparent bg-black/[0.03] p-3 text-left transition enabled:hover:border-violet-400 enabled:hover:bg-violet-50 enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
    >
      {s.story && (
        <span className="text-[10px] font-extrabold uppercase tracking-wide text-fuchsia-600">
          📖 Chapter {s.story.chapter} of {s.story.of}
          {locked ? ` · 🔒 earn ${need - have} more ★ in earlier chapters` : ""}
        </span>
      )}
      <span className="flex items-center justify-between gap-2">
        <span className="font-display text-sm font-bold text-[#241b3d]">{s.name}</span>
        <span
          className={`shrink-0 text-sm tracking-tight ${stars > 0 ? "text-amber-500" : "text-black/15"}`}
          title={stars > 0 ? `Best: ${stars} star${stars > 1 ? "s" : ""}` : "Not cleared yet"}
        >
          {[1, 2, 3].map((i) => (i <= stars ? "★" : "☆")).join("")}
        </span>
      </span>
      {medals.length > 0 && (
        <span className="flex gap-1 text-xs" title={medals.map((m) => MEDAL_META[m]?.label ?? m).join(", ")}>
          {medals.map((m) => (
            <span key={m}>{MEDAL_META[m]?.icon ?? "🏅"}</span>
          ))}
        </span>
      )}
      <span className="text-xs font-semibold text-violet-600">{s.tagline}</span>
      <span className="text-[11px] leading-snug text-zinc-500">{s.briefing}</span>
      <span className="mt-1 flex gap-3 text-[10.5px] font-bold uppercase tracking-wide text-zinc-400">
        <span>⏱ {s.durationS}s</span>
        {s.kind === "manage" ? <span>🔒 build locked</span> : <span>💰 ${(s.startingBudget / 1000).toFixed(0)}k</span>}
        {s.scriptedEvents && <span className="text-orange-500">⚡ scripted trouble</span>}
        {s.real && <span className="text-sky-600">🌎 real roads</span>}
      </span>
    </button>
  );
}

/** Today's daily challenge: same for everyone, with your best score and streak. */
function DailyCard({ onStart }: { onStart: (id: string) => void }) {
  const { today, bestToday, streak } = useDaily();
  const def = buildDailyScenario(today);
  return (
    <button
      type="button"
      onClick={() => onStart(def.id)}
      className="flex flex-col gap-1 rounded-xl border-[3px] border-[#2b1c40] bg-gradient-to-br from-fuchsia-200 to-violet-300 p-3.5 text-left shadow-[0_3px_0_#2b1c40] transition hover:-translate-y-0.5 active:translate-y-0.5"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-display text-sm font-extrabold uppercase text-[#2a1048]">📅 Daily: {def.name}</span>
        {streak > 0 && <span className="shrink-0 text-xs font-extrabold text-orange-600">🔥 {streak}-day streak</span>}
      </span>
      <span className="text-[11px] font-semibold leading-snug text-[#2a1048]/80">{def.briefing}</span>
      <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-[#2a1048]/70">
        {bestToday > 0 ? `Your best today: ${bestToday} moved` : "Not played yet today"} · new one at midnight
      </span>
    </button>
  );
}

function SandboxCard({ onSandbox }: { onSandbox: () => void }) {
  return (
    <button
      type="button"
      onClick={onSandbox}
      className="flex flex-col gap-1 rounded-xl border-[3px] border-[#2b1c40] bg-gradient-to-br from-amber-200 to-orange-300 p-3.5 text-left shadow-[0_3px_0_#2b1c40] transition hover:-translate-y-0.5 active:translate-y-0.5"
    >
      <span className="font-display text-sm font-extrabold uppercase text-[#3b2410]">♾️ Sandbox</span>
      <span className="text-xs font-bold text-[#3b2410]/80">An empty map and no money limit. Build whatever you like.</span>
    </button>
  );
}

function ScenarioPicker({
  onStart,
  onClose,
  hasActiveScenario,
  onFreeBuild,
  onSandbox,
  onPlace,
}: {
  onSandbox: () => void;
  onPlace: (network: NetworkSnapshot, name: string, scenery: SceneryData) => void;
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

        <CareerCard />
        <DailyCard onStart={onStart} />
        <SandboxCard onSandbox={onSandbox} />
        <PlaceSearch onPlace={onPlace} />
        <h3 className="text-[10.5px] font-extrabold uppercase tracking-wide text-fuchsia-600">📖 {STORY_ARC}</h3>
        {SCENARIOS.filter((s) => s.story).map((s) => (
          <ScenarioCard key={s.id} s={s} onStart={onStart} />
        ))}
        <h3 className="mt-1 text-[10.5px] font-extrabold uppercase tracking-wide text-emerald-600">
          Traffic Manager — the city is built, fix the flow
        </h3>
        {SCENARIOS.filter((s) => s.kind === "manage" && !s.story).map((s) => (
          <ScenarioCard key={s.id} s={s} onStart={onStart} />
        ))}
        <h3 className="mt-1 text-[10.5px] font-extrabold uppercase tracking-wide text-violet-600">
          Build &amp; fix — design your own solution
        </h3>
        {SCENARIOS.filter((s) => s.kind !== "manage" && !s.real && !s.story).map((s) => (
          <ScenarioCard key={s.id} s={s} onStart={onStart} />
        ))}
        <h3 className="mt-1 text-[10.5px] font-extrabold uppercase tracking-wide text-sky-600">
          🌎 Real cities — actual roads from OpenStreetMap
        </h3>
        {SCENARIOS.filter((s) => s.real).map((s) => (
          <ScenarioCard key={s.id} s={s} onStart={onStart} />
        ))}
        <p className="text-center text-[10px] font-semibold text-zinc-400">
          Real-city maps © OpenStreetMap contributors (ODbL), openstreetmap.org/copyright
        </p>

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

function StarRow({ stars }: { stars: 0 | 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-1.5">
      {[1, 2, 3].map((i) => (
        <IconStar key={i} className={`h-9 w-9 ${i <= stars ? "text-amber-400" : "text-black/10"}`} />
      ))}
    </div>
  );
}

function ResultsModal({ runner }: { runner: UseScenarioRunnerReturn }) {
  const { scenario, results } = runner;
  const { bestToday } = useDaily();
  const challenge = useActiveChallenge();
  const [replaySaved, setReplaySaved] = useState(false);

  useEffect(() => {
    if (!results) return;
    if (results.won) playVictoryFanfare();
    else playFailTone();
  }, [results]);

  if (!scenario || !results) return null;

  const isLast = SCENARIOS[SCENARIOS.length - 1].id === scenario.id;
  const isDaily = scenario.id.startsWith(DAILY_PREFIX);

  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div className="hud-panel flex max-h-[94vh] w-full max-w-sm flex-col items-center gap-3 overflow-y-auto rounded-2xl p-6 text-center">
        <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">{scenario.name}</span>
        <div
          className={`hover-wiggle flex h-20 w-20 items-center justify-center rounded-full text-3xl font-black text-white shadow-lg ${
            results.won
              ? "bg-gradient-to-br from-amber-400 to-pink-500"
              : "bg-gradient-to-br from-zinc-400 to-zinc-600"
          }`}
        >
          {results.won ? "🏆" : "✗"}
        </div>
        <span className="font-display text-xl font-extrabold text-[#241b3d]">
          {results.won ? "Scenario complete!" : "Time's up — not quite"}
        </span>
        {results.won && <StarRow stars={results.stars} />}

        <div className="flex w-full flex-col gap-1.5">
          {results.summaryLines.map((line, i) => (
            <div key={i} className="rounded-lg bg-black/[0.03] px-3 py-2 text-left text-[11px] text-zinc-700">
              {line}
            </div>
          ))}
          <StatRow label="Avg speed" value={`${results.avgSpeedMph.toFixed(0)} mph`} />
          {scenario.kind !== "manage" && (
            <StatRow label="Budget left" value={`$${Math.max(0, results.budgetRemaining).toLocaleString()}`} />
          )}
        </div>

        {results.won && scenario.story && (
          <p className="w-full rounded-xl bg-fuchsia-500/10 px-3 py-2.5 text-left text-[12px] font-semibold italic leading-snug text-fuchsia-900">📖 {scenario.story.outro}</p>
        )}

        {results.report && <ServiceReportCard report={results.report} payout={results.payout} />}

        {challenge && challenge.scenarioId === scenario.id && results.score !== null && (
          <div
            className={`w-full rounded-xl px-3 py-2.5 text-left text-xs font-bold ${
              results.score > challenge.target ? "bg-emerald-500/15 text-emerald-800" : "bg-orange-500/15 text-orange-800"
            }`}
          >
            {results.score > challenge.target
              ? `⚔️ You beat ${challenge.from}'s ${challenge.target} with ${results.score}!`
              : results.score === challenge.target
                ? `⚔️ A tie with ${challenge.from}: ${results.score} each.`
                : `⚔️ ${challenge.from} scored ${challenge.target}. You scored ${results.score}, ${challenge.target - results.score} short.`}
          </div>
        )}
        {isDaily && results.won && <DailyBoard day={scenario.id.slice(DAILY_PREFIX.length) || dateKey()} score={bestToday} />}

        <div className="mt-2 flex w-full gap-2">
          <button
            type="button"
            onClick={runner.retry}
            className="flex-1 rounded-xl bg-gradient-to-br from-sky-400 to-blue-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            Retry ↻
          </button>
          {results.won && (
            <button
              type="button"
              onClick={runner.nextScenario}
              className="flex-1 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
            >
              {isLast ? "Finish 🏆" : "Next ▶"}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={async () => {
            const stars = `${"★".repeat(results.stars)}${"☆".repeat(3 - results.stars)}`;
            const text = `🚦 ${scenario.name} ${stars}\n${results.summaryLines[0] ?? ""}\nThink you can beat it? ${window.location.origin}/play`;
            try {
              await navigator.clipboard.writeText(text);
              pushToast("📋 Result copied. Paste it to a friend", "good");
            } catch {
              pushToast("Couldn't copy: your browser blocked clipboard access", "bad");
            }
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-black/5 px-3 py-2 text-xs font-bold text-zinc-700 transition hover:bg-black/10 active:scale-95"
        >
          📋 Share my result
        </button>
        <button
          type="button"
          onClick={async () => {
            const card = await makeShareCard({ title: scenario.name, stars: results.stars, lines: results.summaryLines });
            if (!card) {
              pushToast("Couldn't make the picture: the 3D view isn't ready", "bad");
              return;
            }
            const how = await shareOrDownload(card, `road-constructor-${scenario.id}.png`, `${scenario.name} in Road Constructor`);
            pushToast(how === "shared" ? "🖼️ Shared" : "🖼️ Picture saved to your downloads", "good");
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-black/5 px-3 py-2 text-xs font-bold text-zinc-700 transition hover:bg-black/10 active:scale-95"
        >
          🖼️ Save a picture to share
        </button>
        {results.won && results.score !== null && results.score > 0 && (
          <button
            type="button"
            onClick={async () => {
              const from = challengerName();
              const isCustom = scenario.id.startsWith(CHALLENGE_PREFIX);
              const url = await encodeChallenge(
                isCustom
                  ? { kind: "custom", name: scenario.name.slice(0, 40), network: scenario.startingNetwork, from, target: results.score ?? 0 }
                  : { kind: "level", id: scenario.id, from, target: results.score ?? 0 }
              );
              try {
                await navigator.clipboard.writeText(url);
                pushToast(`⚔️ Challenge link copied. Send it to a friend: beat ${results.score}`, "good");
              } catch {
                window.prompt("Copy this challenge link:", url);
              }
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-br from-rose-400 to-orange-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            ⚔️ Challenge a friend to beat {results.score}
          </button>
        )}
        {results.won && (
          <button
            type="button"
            onClick={() => {
              const from = challengerName();
              const isCustom = scenario.id.startsWith(CHALLENGE_PREFIX);
              const score = results.score ?? 0;
              startFlyover({
                name: scenario.name,
                stars: results.stars,
                summary: results.summaryLines[0] ?? "",
                makeLink:
                  score > 0
                    ? () =>
                        encodeChallenge(
                          isCustom
                            ? { kind: "custom", name: scenario.name.slice(0, 40), network: scenario.startingNetwork, from, target: score }
                            : { kind: "level", id: scenario.id, from, target: score }
                        )
                    : null,
              });
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            🎬 {results.stars === 3 ? "Watch your 3★ flyover" : "Drone flyover at dusk"}
          </button>
        )}
        {results.recording && results.recording.length > 0 && (
          <button
            type="button"
            disabled={replaySaved}
            onClick={async () => {
              try {
                const stars = results.won ? results.stars : 0;
                await saveReplay({
                  name: `${scenario.name}${stars > 0 ? ` ${"★".repeat(stars)}` : ""}${results.score !== null ? ` · ${results.score}` : ""}`,
                  scenarioId: scenario.id.startsWith(CHALLENGE_PREFIX) || scenario.id.startsWith(DAILY_PREFIX) ? null : scenario.id,
                  scenarioName: scenario.name,
                  durationS: scenario.durationS,
                  stars,
                  score: results.score,
                  summary: results.summaryLines[0] ?? "",
                  highlights: results.highlights,
                  actions: results.recording ?? [],
                });
                setReplaySaved(true);
                pushToast("🎞️ Replay saved. Watch it from Saves → Replays", "good");
              } catch (e) {
                pushToast(e instanceof Error ? e.message : "Couldn't save the replay", "bad");
              }
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-black/5 px-3 py-2 text-xs font-bold text-zinc-700 transition hover:bg-black/10 active:scale-95 disabled:opacity-60"
          >
            {replaySaved ? "🎞️ Replay saved" : "🎞️ Save the replay of this run"}
          </button>
        )}
        {replaySaved && (
          <button type="button" onClick={() => openSaves("replays")} className="text-[11px] text-violet-700 underline decoration-dotted hover:text-violet-900">
            Open my replays
          </button>
        )}
        {results.won && (
          <button
            type="button"
            onClick={runner.continueSandbox}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            Continue in Sandbox Mode ♾️
          </button>
        )}
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

/** First-visit menu over an empty map: pick a pre-built city to manage, or start from scratch. */
function StartMenu({ onStart, onSandbox, onPlace }: { onStart: (id: string) => void; onSandbox: () => void; onPlace: (network: NetworkSnapshot, name: string, scenery: SceneryData) => void }) {
  const cities = SCENARIOS.filter((s) => s.id === "first-shift" || s.id === "midtown" || s.id === "harbor-drive");
  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="hud-panel flex max-h-[90vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-2xl p-6">
        <div>
          <h2 className="font-display text-2xl font-extrabold uppercase text-[#241b3d]">What are we doing today?</h2>
          <p className="mt-1 text-sm font-semibold text-zinc-600">
            Skip the city-building. Jump into a city that&apos;s already jammed and fix how traffic flows.
          </p>
        </div>
        <DailyCard onStart={onStart} />
        {cities.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onStart(s.id)}
            className="flex flex-col gap-1 rounded-xl border-[3px] border-[#2b1c40] bg-gradient-to-br from-emerald-300 to-teal-400 p-4 text-left shadow-[0_4px_0_#2b1c40] transition hover:-translate-y-0.5 active:translate-y-0.5"
          >
            <span className="font-display text-lg font-extrabold uppercase text-[#10332b]">
              🚦 {s.name}
              {s.id === "first-shift" && <span className="ml-2 rounded-full bg-[#10332b] px-2 py-0.5 text-[10px] tracking-wider text-white">Start here</span>}
            </span>
            <span className="text-sm font-bold text-[#10332b]/80">{s.tagline}</span>
            <span className="text-xs font-semibold text-[#10332b]/70">Traffic Manager · roads are locked · {s.durationS}s shift</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onSandbox}
          className="flex flex-col items-center gap-0.5 rounded-xl border-[3px] border-[#2b1c40] bg-gradient-to-br from-amber-200 to-orange-300 p-3.5 shadow-[0_4px_0_#2b1c40] transition hover:-translate-y-0.5 active:translate-y-0.5"
        >
          <span className="font-display text-base font-extrabold uppercase text-[#3b2410]">♾️ Sandbox</span>
          <span className="text-xs font-bold text-[#3b2410]/80">Build your own roads with no money limit</span>
        </button>
        <PlaceSearch onPlace={onPlace} />
      </div>
    </div>
  );
}

export default function ScenarioHud({ runner }: { runner: UseScenarioRunnerReturn }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [introFor, setIntroFor] = useState<ScenarioDef | null>(null);
  const [startDismissed, setStartDismissed] = useState(false);
  const isEmptyMap = useEditorStore((s) => s.nodes.length === 0);
  const startSandbox = useEditorStore((s) => s.startSandbox);
  const startPlace = useEditorStore((s) => s.startPlace);
  const starTotal = totalStars(useProgress());
  const inSandbox = useEditorStore((s) => isSandboxBudget(s.budget));
  const { scenario } = runner;
  // /play?sandbox=1 (from the landing page) drops straight into a fresh, unlimited Sandbox.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("sandbox")) return;
    startSandbox();
    params.delete("sandbox");
    const query = params.toString();
    history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
  }, [startSandbox]);
  const showStartMenu = isEmptyMap && !scenario && !startDismissed && !pickerOpen && !inSandbox;

  return (
    <>
      <div className="pointer-events-auto absolute bottom-4 left-4 z-20 flex max-w-[calc(100vw-2rem)] flex-col items-start gap-1.5">
        {scenario && runner.progress && (
          <span className="hud-panel max-w-[12rem] truncate rounded-full px-3 py-1 text-[10.5px] font-bold text-zinc-600 sm:max-w-none">
            {runner.progress.label}
          </span>
        )}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="hud-panel flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-bold text-[#241b3d] transition hover:brightness-105 active:scale-95"
        >
          {scenario ? (
            <>
              <IconClock className="h-3.5 w-3.5 text-violet-600" />
              <span className="hidden sm:inline">{scenario.name} · </span>
              {formatMMSS(runner.remainingS)}
            </>
          ) : (
            <>
              <IconFlag className="h-3.5 w-3.5 text-violet-600" />
              Campaign
              {starTotal > 0 && <span className="text-amber-500">★ {starTotal}</span>}
            </>
          )}
        </button>
      </div>

      {showStartMenu && (
        <StartMenu
          onStart={(id) => {
            const def = getScenarioById(id);
            if (def) runner.startScenario(def);
          }}
          onPlace={(network, name, scenery) => {
            startPlace(network, name, scenery);
            setStartDismissed(true);
          }}
          onSandbox={() => {
            startSandbox();
            setStartDismissed(true);
          }}
        />
      )}

      {pickerOpen && !runner.results && (
        <ScenarioPicker
          hasActiveScenario={!!scenario}
          onStart={(id) => {
            const def = getScenarioById(id);
            setActiveChallenge(null);
            setPickerOpen(false);
            // A story chapter opens with its introduction; everything else starts straight away.
            if (def?.story) setIntroFor(def);
            else if (def) runner.startScenario(def);
          }}
          onClose={() => setPickerOpen(false)}
          onFreeBuild={() => {
            runner.exitToFreeBuild();
            setPickerOpen(false);
          }}
          onPlace={(network, name, scenery) => {
            startPlace(network, name, scenery);
            setPickerOpen(false);
          }}
          onSandbox={() => {
            startSandbox();
            setPickerOpen(false);
          }}
        />
      )}

      {introFor && (
        <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="hud-panel flex w-full max-w-sm flex-col gap-3 rounded-2xl p-6 text-center">
            <span className="text-[11px] font-extrabold uppercase tracking-wide text-fuchsia-600">
              📖 {introFor.story?.arc} · Chapter {introFor.story?.chapter} of {introFor.story?.of}
            </span>
            <h2 className="font-display text-2xl font-extrabold text-[#241b3d]">{introFor.name}</h2>
            <p className="text-[13px] font-semibold italic leading-relaxed text-zinc-700">{introFor.story?.intro}</p>
            <p className="rounded-xl bg-black/[0.04] px-3 py-2 text-left text-[11.5px] leading-snug text-zinc-600">{introFor.briefing}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setIntroFor(null)} className="flex-1 rounded-xl bg-black/5 py-2 text-xs font-bold text-zinc-700 hover:bg-black/10">
                Not yet
              </button>
              <button
                type="button"
                onClick={() => {
                  const def = introFor;
                  setIntroFor(null);
                  runner.startScenario(def);
                }}
                className="flex-1 rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-600 py-2 text-xs font-bold text-white shadow-sm hover:brightness-110 active:scale-95"
              >
                Begin the chapter ▶
              </button>
            </div>
          </div>
        </div>
      )}
      {runner.results && <ResultsModal runner={runner} />}
    </>
  );
}
