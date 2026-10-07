"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  QUALITY_SETTINGS,
  getGraphicsOverrides,
  setGraphicsOption,
  setQuality,
  useGraphics,
  useQuality,
  type GraphicsOverrides,
  type Quality,
} from "@/lib/quality";
import { setPref, usePrefs } from "@/lib/prefs";
import { SOUND_CHECKS, getMixLevels, isMuted, playSoundCheck, resetMix, setMixLevel, subscribeMix, subscribeMuted, toggleMuted, type MixLevels } from "@/lib/sound";
import { setSettingsOpen, useSettingsOpen } from "@/lib/settingsMenu";

const PRESETS: { id: Quality; name: string; blurb: string; emoji: string }[] = [
  { id: "high", name: "High", blurb: "Shadows, bloom and ambient occlusion. For a desktop or a recent Mac.", emoji: "✨" },
  { id: "medium", name: "Medium", blurb: "Shadows and detailed cars, no post-processing. A good default for most laptops.", emoji: "⚖️" },
  { id: "low", name: "Low", blurb: "Plain and light: runs cool and quiet on older machines and phones.", emoji: "🔋" },
];

const FPS_CHOICES = [30, 45, 60];
const RESOLUTION_CHOICES: { label: string; value: number }[] = [
  { label: "Standard", value: 1 },
  { label: "Sharp", value: 1.5 },
  { label: "Retina", value: 2 },
];
const CAR_CHOICES = [250, 500, 1000, 1500];

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-black/[0.04]"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-bold text-[#241b3d]">{label}</span>
        {hint && <span className="block text-[11px] font-semibold leading-snug text-zinc-500">{hint}</span>}
      </span>
      <span className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition ${on ? "bg-emerald-500" : "bg-zinc-300"}`}>
        <span className={`h-5 w-5 rounded-full bg-white shadow transition ${on ? "translate-x-5" : ""}`} />
      </span>
    </button>
  );
}

function Segmented<T extends number | string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <span className="text-[13px] font-bold text-[#241b3d]">{label}</span>
      {hint && <span className="-mt-1 text-[11px] font-semibold leading-snug text-zinc-500">{hint}</span>}
      <div className="flex gap-1 rounded-xl bg-black/5 p-1">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition ${
              value === o.value ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow" : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 text-[10.5px] font-extrabold uppercase tracking-wide text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

function GraphicsSection() {
  const quality = useQuality();
  const g = useGraphics();
  const [advanced, setAdvanced] = useState(false);
  const overrides: GraphicsOverrides = getGraphicsOverrides();
  const tweaked = Object.keys(overrides).length > 0;

  return (
    <Section title="Graphics">
      <div className="grid gap-2 sm:grid-cols-3">
        {PRESETS.map((p) => {
          const active = quality === p.id && !tweaked;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={active}
              onClick={() => setQuality(p.id)}
              className={`flex flex-col gap-1 rounded-2xl border-[3px] p-3 text-left transition active:scale-[0.98] ${
                active
                  ? "border-[#241b3d] bg-gradient-to-br from-violet-100 to-fuchsia-100 shadow-[0_3px_0_#241b3d]"
                  : quality === p.id
                    ? "border-violet-300 bg-violet-50"
                    : "border-black/10 bg-white hover:border-black/25"
              }`}
            >
              <span className="font-display text-sm font-extrabold uppercase text-[#241b3d]">
                {p.emoji} {p.name}
              </span>
              <span className="text-[11px] font-semibold leading-snug text-zinc-600">{p.blurb}</span>
            </button>
          );
        })}
      </div>
      <p className="px-1 text-[11px] font-semibold text-zinc-500">
        {tweaked ? `${PRESETS.find((p) => p.id === quality)?.name} with your changes.` : "Weak machine? The game also steps down by itself if it can't keep up."}
      </p>

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
        className="mt-1 self-start rounded-lg px-2 py-1 text-xs font-bold text-violet-700 hover:bg-violet-50"
      >
        {advanced ? "▾ Hide advanced" : "▸ Advanced options"}
      </button>
      {advanced && (
        <div className="flex flex-col rounded-2xl bg-black/[0.03] py-1">
          <Toggle label="Shadows" hint="The biggest cost after resolution." on={g.shadows} onChange={(v) => setGraphicsOption("shadows", v)} />
          <Toggle label="Bloom and ambient occlusion" hint="Soft glow and contact shadows. Heavy on integrated graphics." on={g.postprocessing} onChange={(v) => setGraphicsOption("postprocessing", v)} />
          <Toggle label="Smooth edges (antialiasing)" hint="Restarts the 3D view when changed." on={g.antialias} onChange={(v) => setGraphicsOption("antialias", v)} />
          <Toggle label="Detailed vehicles" hint="Cars with a cabin, wheels and lights instead of plain boxes." on={g.detailedVehicles} onChange={(v) => setGraphicsOption("detailedVehicles", v)} />
          <Toggle label="Buildings and scenery" hint="Buildings, water and trees around the roads." on={g.setDressing} onChange={(v) => setGraphicsOption("setDressing", v)} />
          <Toggle label="Rain effect" hint="The falling streaks. Rain still slows traffic either way." on={g.weatherEffects} onChange={(v) => setGraphicsOption("weatherEffects", v)} />
          <Segmented label="Resolution" hint="Higher is sharper and hotter." value={g.dpr[1]} options={RESOLUTION_CHOICES} onChange={(v) => setGraphicsOption("dprMax", v)} />
          <Segmented label="Frame rate cap" hint="A lower cap runs cooler and quieter." value={g.maxFps} options={FPS_CHOICES.map((f) => ({ label: `${f} fps`, value: f }))} onChange={(v) => setGraphicsOption("maxFps", v)} />
          <Segmented label="Most cars at once" hint="Fewer cars is lighter on the simulation too." value={g.vehicleCap} options={CAR_CHOICES.map((n) => ({ label: String(n), value: n }))} onChange={(v) => setGraphicsOption("vehicleCap", v)} />
          {tweaked && (
            <button type="button" onClick={() => setQuality(quality)} className="m-2 self-start rounded-lg bg-black/5 px-3 py-1.5 text-xs font-bold text-zinc-700 hover:bg-black/10">
              Reset to the {QUALITY_SETTINGS[quality] && PRESETS.find((p) => p.id === quality)?.name} preset
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

const MIX_CONTROLS: { key: keyof MixLevels; label: string; hint: string }[] = [
  { key: "master", label: "Master", hint: "Everything, through a limiter so loud moments never distort." },
  { key: "effects", label: "Interface and music cues", hint: "Placing and demolishing roads, goals, fanfares, combos." },
  { key: "ambience", label: "Traffic and weather", hint: "Engines, tyre roar, rain, concrete, horns, your own engine. It dips when a siren sounds." },
  { key: "alerts", label: "Sirens and warnings", hint: "Ambulances, warning banners, crossing beeps, tyre squeal." },
];

function SoundSection() {
  const [muted, setMuted] = useState(false);
  const [mix, setMix] = useState<MixLevels>(() => getMixLevels());
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setMuted(isMuted());
      setMix(getMixLevels());
    });
    const offMute = subscribeMuted(setMuted);
    const offMix = subscribeMix(() => setMix(getMixLevels()));
    return () => {
      cancelAnimationFrame(raf);
      offMute();
      offMix();
    };
  }, []);
  const check = (id: string) => {
    const ms = playSoundCheck(id);
    setPlaying(id);
    window.setTimeout(() => setPlaying((p) => (p === id ? null : p)), ms);
  };
  return (
    <Section title="Sound">
      <Toggle label="Sound on" hint="Traffic hum, engines, rain, sirens and the little chimes." on={!muted} onChange={() => toggleMuted()} />
      <div className={`flex flex-col gap-2 rounded-2xl bg-black/[0.03] px-3 py-2.5 ${muted ? "opacity-50" : ""}`}>
        {MIX_CONTROLS.map((c) => (
          <label key={c.key} className="flex flex-col gap-0.5">
            <span className="flex items-center justify-between text-[12px] font-bold text-[#241b3d]">
              {c.label}
              <span className="tabular-nums text-zinc-500">{Math.round(mix[c.key] * 100)}%</span>
            </span>
            <input type="range" min={0} max={1.5} step={0.05} value={mix[c.key]} onChange={(e) => setMixLevel(c.key, Number(e.target.value))} className="accent-violet-600" aria-label={`${c.label} volume`} />
            <span className="text-[10.5px] font-semibold leading-snug text-zinc-500">{c.hint}</span>
          </label>
        ))}
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-zinc-400">Sound check</span>
          <div className="flex flex-wrap gap-1.5">
            {SOUND_CHECKS.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={muted}
                onClick={() => check(c.id)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition active:scale-95 disabled:cursor-not-allowed ${playing === c.id ? "bg-violet-600 text-white" : "bg-white text-zinc-700 shadow-sm hover:bg-violet-50"}`}
              >
                {playing === c.id ? "🔊" : "▶"} {c.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={resetMix} className="self-start rounded-lg px-2 py-1 text-[11px] font-bold text-violet-700 hover:bg-violet-50">
            Reset the mix
          </button>
        </div>
      </div>
    </Section>
  );
}

function AccessibilitySection() {
  const prefs = usePrefs();
  return (
    <Section title="Comfort and accessibility">
      <Toggle label="Reduce motion" hint="Stops rain streaks, confetti, pulsing markers, roads rising into place and the photo-mode orbit." on={prefs.reducedMotion} onChange={(v) => setPref("reducedMotion", v)} />
      <Toggle label="Larger text" hint="Scales the whole interface up about 12%." on={prefs.largeText} onChange={(v) => setPref("largeText", v)} />
      <Toggle label="Bold markers" hint="Bigger jam and incident markers with a heavy outline, so they read without relying on colour." on={prefs.boldMarkers} onChange={(v) => setPref("boldMarkers", v)} />
    </Section>
  );
}

/** The settings menu: graphics presets with advanced options, sound, and accessibility. Opens from the top bar's gear. */
export default function SettingsMenu() {
  const open = useSettingsOpen();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="hud-panel flex max-h-[88vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-3xl p-5 hud-scrollbar">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-extrabold uppercase text-[#241b3d]">⚙️ Settings</h2>
          <button type="button" onClick={() => setSettingsOpen(false)} className="rounded-full bg-black/5 px-3 py-1.5 text-xs font-bold text-zinc-700 hover:bg-black/10">
            Done
          </button>
        </div>
        <GraphicsSection />
        <SoundSection />
        <AccessibilitySection />
      </div>
    </div>
  );
}
