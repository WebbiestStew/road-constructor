"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { downloadNetworkFile, encodePayloadToShareHash, parseNetworkFile } from "@/state/persistence";
import { isMuted, subscribeMuted, toggleMuted } from "@/lib/sound";
import { requestOpenTutorial } from "@/lib/tutorial";
import { setChaos, useChaos } from "@/lib/chaos";
import { useQuality } from "@/lib/quality";
import { setSettingsOpen } from "@/lib/settingsMenu";
import { openSaves } from "@/lib/savesMenu";
import { setGalleryOpen } from "@/lib/galleryMenu";
import { galleryEnabled } from "@/lib/gallery";
import { requestMakeChallenge, requestPublish } from "@/lib/challenge";
import { toggleTour, togglePhotoMode } from "@/lib/photoMode";
import { useCompact } from "@/lib/compact";
import {
  IconArrowLeft,
  IconDownload,
  IconHeatmap,
  IconHelp,
  IconMoon,
  IconNight,
  IconPause,
  IconPlay,
  IconRedo,
  IconReset,
  IconRideAlong,
  IconRoad,
  IconShare,
  IconSpeakerOff,
  IconSpeakerOn,
  IconSun,
  IconUndo,
  IconUpload,
} from "./icons";

const TIME_OF_DAY_OPTIONS: { id: "day" | "dusk" | "night"; icon: ComponentType<SVGProps<SVGSVGElement>>; label: string }[] = [
  { id: "day", icon: IconSun, label: "Day" },
  { id: "dusk", icon: IconMoon, label: "Dusk" },
  { id: "night", icon: IconNight, label: "Night" },
];

const SPEED_OPTIONS = [1, 2, 5, 10];
const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";
/** Set NEXT_PUBLIC_FEEDBACK_URL (issue tracker, form, mailto:) to show the feedback link. */
const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL;


/** Free-play toys that stir things up: send an ambulance, cause a crash, switch on chaos, change the weather, run a 24-hour day. */
function EventsMenu({ sim }: { sim: UseTrafficSimulationReturn }) {
  const [open, setOpen] = useState(false);
  const chaos = useChaos();
  const weather = useEditorStore((s) => s.weather);
  const setWeather = useEditorStore((s) => s.setWeather);
  const dayCycle = useEditorStore((s) => s.dayCycle);
  const setDayCycle = useEditorStore((s) => s.setDayCycle);
  const elastic = useEditorStore((s) => s.elasticDemand);
  const risk = useEditorStore((s) => s.crashRisk);
  const waits = useEditorStore((s) => s.pedWaits);
  const setRule = useEditorStore((s) => s.setFreePlayRule);
  const active = chaos || dayCycle || weather !== "clear";
  const item = "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-bold text-zinc-700 transition hover:bg-black/5 active:scale-[0.99]";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Events: ambulance, crash, stalls, debris, chaos, weather, day cycle"
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition ${
          active ? "bg-gradient-to-br from-amber-400 to-red-500 text-white shadow" : "bg-black/5 text-zinc-600 hover:text-zinc-900"
        }`}
      >
        🎲 Events{active ? " •" : ""}
      </button>
      {open && (
        <div className="hud-panel animate-pop absolute left-0 top-full z-40 mt-2 flex w-60 flex-col gap-0.5 rounded-2xl p-1.5">
          <button type="button" className={item} onClick={() => { sim.triggerAmbulance(); setOpen(false); }}>
            🚑 <span>Send an ambulance</span>
          </button>
          <button type="button" className={item} onClick={() => { sim.triggerCrash(); setOpen(false); }}>
            💥 <span>Cause a crash</span>
          </button>
          <button type="button" className={item} onClick={() => { sim.triggerIncident("stall"); setOpen(false); }}>
            🚛 <span>Stall an 18-wheeler</span>
          </button>
          <button type="button" className={item} onClick={() => { sim.triggerIncident("debris"); setOpen(false); }}>
            🧱 <span>Drop debris on the road</span>
          </button>
          <button type="button" className={item} onClick={() => { sim.triggerIncident("fender"); setOpen(false); }}>
            🚗 <span>Fender bender</span>
          </button>
          <button type="button" className={`${item} ${chaos ? "bg-amber-100" : ""}`} aria-pressed={chaos} onClick={() => setChaos(!chaos)}>
            🎲 <span>Chaos mode {chaos ? "(on)" : ""}</span>
          </button>
          <button type="button" className={`${item} ${dayCycle ? "bg-amber-100" : ""}`} aria-pressed={dayCycle} onClick={() => setDayCycle(!dayCycle)}>
            🕒 <span>24-hour day {dayCycle ? "(on)" : ""}</span>
          </button>
          <div className="mx-2 my-1 h-px bg-black/10" />
          <span className="px-3 pt-1 text-[10px] font-extrabold uppercase tracking-wide text-zinc-400">Rules of the city</span>
          <button type="button" className={`${item} ${elastic ? "bg-emerald-50" : ""}`} aria-pressed={elastic} title="A road that flows draws more drivers; a jammed one loses them (some take the bus)" onClick={() => setRule("elasticDemand", !elastic)}>
            📈 <span>Demand follows the roads {elastic ? "(on)" : "(off)"}</span>
          </button>
          <button type="button" className={`${item} ${risk ? "bg-emerald-50" : ""}`} aria-pressed={risk} title="Speeding, rain, fog, darkness and tailgating cause crashes" onClick={() => setRule("crashRisk", !risk)}>
            💥 <span>Crashes can happen {risk ? "(on)" : "(off)"}</span>
          </button>
          <button type="button" className={`${item} ${waits ? "bg-emerald-50" : ""}`} aria-pressed={waits} title="People wait for a gap or the button, and the wait is scored" onClick={() => setRule("pedWaits", !waits)}>
            🚶 <span>People wait to cross {waits ? "(on)" : "(off)"}</span>
          </button>
          <div className="flex items-center gap-1 px-2 py-1.5">
            <span className="mr-1 text-[11px] font-extrabold uppercase text-zinc-400">Weather</span>
            {(["clear", "rain", "fog"] as const).map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={weather === w}
                onClick={() => setWeather(w)}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition ${weather === w ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow" : "bg-black/5 text-zinc-600 hover:bg-black/10"}`}
              >
                {w === "clear" ? "☀️" : w === "rain" ? "🌧️" : "🌫️"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function TopBar({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const buildLocked = useEditorStore((s) => s.buildLocked);
  const scenarioActive = useEditorStore((s) => s.activeScenarioId !== null);
  const replaying = useEditorStore((s) => s.replay !== null);
  const quality = useQuality();
  const heatmapEnabled = useEditorStore((s) => s.heatmapEnabled);
  const setHeatmapEnabled = useEditorStore((s) => s.setHeatmapEnabled);
  const rideAlongActive = useEditorStore((s) => s.rideAlongActive);
  const setRideAlongActive = useEditorStore((s) => s.setRideAlongActive);
  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  const setTimeOfDay = useEditorStore((s) => s.setTimeOfDay);
  const [muted, setMutedState] = useState(false);
  // The community gallery needs a store on the server; without one the button is hidden.
  const [hasGallery, setHasGallery] = useState(false);
  useEffect(() => {
    let alive = true;
    void galleryEnabled().then((on) => alive && setHasGallery(on));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMutedState(isMuted()));
    const unsubscribe = subscribeMuted(setMutedState);
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const exportPayload = useEditorStore((s) => s.exportPayload);
  const importPayload = useEditorStore((s) => s.importPayload);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { speedMultiplier, setSpeedMultiplier, running, setRunning, resetTraffic } = sim;
  const [shareState, setShareState] = useState<"idle" | "copied" | "error">("idle");

  const handleImportFile = async (file: File) => {
    const text = await file.text();
    const payload = parseNetworkFile(text);
    if (!payload) {
      window.alert("That file doesn't look like a valid Road Constructor network export.");
      return;
    }
    importPayload(payload);
  };

  const handleShare = async () => {
    try {
      const hash = await encodePayloadToShareHash(exportPayload());
      const url = `${window.location.origin}${window.location.pathname}#data=${hash}`;
      await navigator.clipboard.writeText(url);
      setShareState("copied");
    } catch {
      setShareState("error");
    }
    setTimeout(() => setShareState("idle"), 2000);
  };

  const compact = useCompact();
  const [menuOpen, setMenuOpen] = useState(false);

  const logo = (
      <Link href="/" title="Back to home" className="flex items-center gap-1.5 pl-1.5 pr-2.5">
        <span className="hover-wiggle flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-white shadow-sm">
          <IconRoad className="h-4 w-4" />
        </span>
        <span className="font-display hidden text-base font-extrabold tracking-tight text-[#241b3d] sm:inline">
          Road Constructor
        </span>
        <span
          title={VERSION ? `Beta v${VERSION}` : "Beta"}
          className="rounded-full bg-[#241b3d] px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-white"
        >
          Beta
        </span>
      </Link>
  );

  const modeBlock = replaying ? (
    <span className="rounded-full bg-gradient-to-br from-violet-50 to-fuchsia-50 px-3 py-1.5 text-xs font-bold text-violet-700 ring-1 ring-inset ring-violet-200">🎞️ Replay</span>
  ) : (
    <>
      {mode === "build" ? (
        <div className="flex items-center gap-1 rounded-full bg-black/5 p-1">
          <button
            type="button"
            onClick={() => setMode("build")}
            className="rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 px-3.5 py-1.5 text-xs font-bold text-white shadow"
          >
            Build
          </button>
          <button
            type="button"
            onClick={() => setMode("simulate")}
            title="Open the network to simulated traffic"
            className="rounded-full px-3.5 py-1.5 text-xs font-bold text-zinc-600 transition hover:text-zinc-900"
          >
            Open to Traffic 🚦
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 rounded-full bg-gradient-to-br from-emerald-50 to-teal-50 p-1 ring-1 ring-inset ring-emerald-200">
          {buildLocked ? (
            <span className="px-2.5 py-1.5 text-xs font-bold text-emerald-700">Traffic Manager 🚦</span>
          ) : (
            <button
              type="button"
              onClick={() => setMode("build")}
              title="Back to Build"
              className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-bold text-emerald-700 transition hover:bg-white/70"
            >
              <IconArrowLeft className="h-3.5 w-3.5" />
              Build
            </button>
          )}
          <div className="h-6 w-px bg-emerald-900/10" />
          <button
            type="button"
            onClick={() => setRunning(!running)}
            title={running ? "Pause simulation (Space)" : "Play simulation (Space)"}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow"
          >
            {running ? <IconPause className="h-3.5 w-3.5" /> : <IconPlay className="h-3.5 w-3.5" />}
          </button>
          <div className="flex items-center gap-0.5 rounded-full bg-white/60 p-0.5">
            {SPEED_OPTIONS.map((mult) => (
              <button
                key={mult}
                type="button"
                onClick={() => setSpeedMultiplier(mult)}
                title={`${mult}× speed`}
                className={`rounded-full px-2 py-1 text-[11px] font-bold tabular-nums transition ${
                  speedMultiplier === mult
                    ? "bg-gradient-to-br from-sky-400 to-blue-500 text-white"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {mult}×
              </button>
            ))}
          </div>
          <div className="h-6 w-px bg-emerald-900/10" />
          <button
            type="button"
            onClick={resetTraffic}
            title="Reset traffic to a clean slate"
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-bold text-emerald-700 transition hover:bg-white/70"
          >
            <IconReset className="h-3.5 w-3.5" />
            Reset Traffic
          </button>
        </div>
      )}
    </>
  );

  const buildTools = (
    <>
      {mode === "build" && (
        <>
          <div className="h-6 w-px bg-black/10" />
          <div className="flex items-center gap-0.5 max-md:hidden">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <IconUndo className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <IconRedo className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="h-6 w-px bg-black/10" />
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => downloadNetworkFile(exportPayload())}
              title="Export network to a file"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
            >
              <IconDownload className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Import network from a file"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
            >
              <IconUpload className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={requestMakeChallenge}
              title="Turn this city into a challenge: play it once, then send a friend the score to beat"
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-bold text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
            >
              ⚔️ Challenge
            </button>
            <button
              type="button"
              onClick={requestPublish}
              title="Publish this city as a level: its star lines are measured from what the unchanged city moves"
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-bold text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
            >
              📤 Publish
            </button>
            <button
              type="button"
              onClick={() => void handleShare()}
              title="Copy a shareable link to this layout"
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-bold text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
            >
              <IconShare className="h-3.5 w-3.5" />
              {shareState === "copied" ? "Link copied! 🔗" : shareState === "error" ? "Couldn't copy" : "Share"}
            </button>
          </div>
        </>
      )}
    </>
  );

  const simTools = (
    <>
      {mode === "simulate" && (
        <>
          <div className="h-6 w-px bg-black/10" />
          <button
            type="button"
            onClick={() => setHeatmapEnabled(!heatmapEnabled)}
            title="Toggle traffic speed heatmap"
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition ${
              heatmapEnabled
                ? "bg-gradient-to-br from-rose-400 to-orange-500 text-white shadow"
                : "bg-black/5 text-zinc-600 hover:text-zinc-900"
            }`}
          >
            <IconHeatmap className="h-3.5 w-3.5" />
            Heatmap
          </button>
          <button
            type="button"
            onClick={() => setRideAlongActive(!rideAlongActive)}
            disabled={sim.metrics.activeCount === 0 && !rideAlongActive}
            title={
              sim.metrics.activeCount === 0 && !rideAlongActive
                ? "No traffic on the road yet"
                : "Ride along with a vehicle from a chase camera"
            }
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-30 ${
              rideAlongActive
                ? "bg-gradient-to-br from-sky-400 to-indigo-500 text-white shadow"
                : "bg-black/5 text-zinc-600 hover:text-zinc-900"
            }`}
          >
            <IconRideAlong className="h-3.5 w-3.5" />
            Ride Along
          </button>
          {!scenarioActive && !replaying && <EventsMenu sim={sim} />}
        </>
      )}
    </>
  );

  const envTools = (
    <>
      <div className="h-6 w-px bg-black/10" />
      <div className="flex items-center gap-0.5 rounded-full bg-black/5 p-1">
        {TIME_OF_DAY_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => setTimeOfDay(opt.id)}
            title={opt.label}
            className={`flex h-6 w-6 items-center justify-center rounded-full transition ${
              timeOfDay === opt.id
                ? opt.id === "day"
                  ? "bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow"
                  : opt.id === "dusk"
                    ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow"
                    : "bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow"
                : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            <opt.icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
      <div className="h-6 w-px bg-black/10" />
      <button
        type="button"
        onClick={toggleMuted}
        title={muted ? "Unmute sound" : "Mute sound"}
        className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
      >
        {muted ? <IconSpeakerOff className="h-3.5 w-3.5" /> : <IconSpeakerOn className="h-3.5 w-3.5" />}
      </button>
      {hasGallery && (
        <button
          type="button"
          onClick={() => setGalleryOpen(true)}
          title="Levels other players published"
          aria-label="Community levels"
          className="flex h-7 items-center justify-center gap-1 rounded-full px-2 text-sm text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
        >
          🌐
          <span className="text-[10px] font-extrabold uppercase">Community</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => openSaves()}
        title="Save slots and replays of your runs"
        aria-label="Saves and replays"
        className="flex h-7 items-center justify-center gap-1 rounded-full px-2 text-sm text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
      >
        💾
        <span className="text-[10px] font-extrabold uppercase">Saves</span>
      </button>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title="Settings: graphics, sound and accessibility"
        aria-label="Settings"
        className="flex h-7 items-center justify-center gap-1 rounded-full px-2 text-sm text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
      >
        ⚙️
        <span className="text-[10px] font-extrabold uppercase">{quality === "high" ? "High" : quality === "medium" ? "Med" : "Low"}</span>
      </button>
      {FEEDBACK_URL && (
        <a
          href={FEEDBACK_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="Send beta feedback"
          className="flex h-7 items-center justify-center rounded-full px-2 text-[11px] font-bold text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
        >
          Feedback
        </a>
      )}
      <button
        type="button"
        onClick={toggleTour}
        title="Cinematic tour: hides the UI and flies around your city"
        className="flex h-7 items-center justify-center rounded-full px-2 text-sm text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
      >
        🎬
      </button>
      <button
        type="button"
        onClick={togglePhotoMode}
        title="Photo mode (H): hide the UI, slow orbit, save a picture"
        className="flex h-7 items-center justify-center rounded-full px-2 text-sm text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
      >
        📸
      </button>
      <button
        type="button"
        onClick={requestOpenTutorial}
        title="How to play"
        className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
      >
        <IconHelp className="h-3.5 w-3.5" />
      </button>
    </>
  );

  if (compact) {
    return (
      <>
        <div className="pointer-events-auto absolute left-2 right-2 top-2 z-20 flex items-center gap-1 rounded-2xl p-1 hud-panel">
          <Link href="/" title="Back to home" className="flex shrink-0 items-center pl-1 pr-1.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-white shadow-sm">
              <IconRoad className="h-4 w-4" />
            </span>
          </Link>
          {mode === "build" ? (
            <div className="flex items-center gap-0.5 rounded-full bg-black/5 p-0.5">
              <span className="rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 px-3 py-2 text-xs font-bold text-white shadow">
                Build
              </span>
              <button
                type="button"
                onClick={() => setMode("simulate")}
                className="rounded-full px-3 py-2 text-xs font-bold text-zinc-600"
              >
                Traffic 🚦
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 rounded-full bg-gradient-to-br from-emerald-50 to-teal-50 p-0.5 ring-1 ring-inset ring-emerald-200">
              {buildLocked ? (
                <span className="px-2 text-xs font-bold text-emerald-700">Manager 🚦</span>
              ) : (
                <button
                  type="button"
                  onClick={() => setMode("build")}
                  className="flex items-center gap-1 rounded-full px-2.5 py-2 text-xs font-bold text-emerald-700"
                >
                  <IconArrowLeft className="h-3.5 w-3.5" />
                  Build
                </button>
              )}
              <button
                type="button"
                onClick={() => setRunning(!running)}
                aria-label={running ? "Pause" : "Play"}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow"
              >
                {running ? <IconPause className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => setSpeedMultiplier(SPEED_OPTIONS[(SPEED_OPTIONS.indexOf(speedMultiplier) + 1) % SPEED_OPTIONS.length])}
                aria-label="Change simulation speed"
                className="h-8 min-w-9 rounded-full bg-white/70 px-2 text-[11px] font-extrabold tabular-nums text-sky-700"
              >
                {speedMultiplier}×
              </button>
            </div>
          )}
          <div className="flex-1" />
          {mode === "build" && (
            <>
              <button
                type="button"
                onClick={undo}
                disabled={!canUndo}
                aria-label="Undo"
                className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-600 disabled:opacity-30"
              >
                <IconUndo className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={!canRedo}
                aria-label="Redo"
                className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-600 disabled:opacity-30"
              >
                <IconRedo className="h-4 w-4" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More options"
            aria-expanded={menuOpen}
            className={`flex h-9 w-9 items-center justify-center rounded-full text-lg font-black leading-none ${
              menuOpen ? "bg-[#241b3d] text-white" : "text-zinc-600"
            }`}
          >
            ⋯
          </button>
        </div>
        {menuOpen && (
          <div className="animate-pop pointer-events-auto absolute left-2 right-2 top-[3.75rem] z-30 flex flex-wrap items-center gap-1.5 rounded-2xl p-2.5 hud-panel [&_.h-6.w-px]:hidden">
            {mode === "simulate" && !replaying && (
              <button
                type="button"
                onClick={resetTraffic}
                className="flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-2 text-xs font-bold text-emerald-700"
              >
                <IconReset className="h-3.5 w-3.5" />
                Reset Traffic
              </button>
            )}
            {mode === "build" ? buildTools : simTools}
            {envTools}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="pointer-events-auto absolute left-4 top-4 z-20 flex max-w-[calc(100vw-5.5rem)] flex-wrap items-center gap-1 rounded-2xl p-1.5 hud-panel lg:max-w-none lg:flex-nowrap lg:rounded-full">
      {logo}

      <div className="h-6 w-px bg-black/10" />

      {modeBlock}

      {buildTools}

      {simTools}

      {envTools}
    </div>
  );
}
