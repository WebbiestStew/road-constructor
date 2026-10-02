"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { useDemoTraffic } from "@/hooks/useDemoTraffic";
import { getDemoCity } from "@/sim/demoCity";
import { SCENARIOS } from "@/sim/scenarios";
import { useWebGLSupported } from "@/lib/webgl";
import {
  IconGauge,
  IconHeatmap,
  IconLanes,
  IconSpeedSign,
  IconPlay,
  IconRoad,
  IconSignal,
  IconWarning,
} from "@/components/hud/icons";

// Three.js is heavy — keep it out of the server render and the initial JS bundle.
const HeroScene = dynamic(() => import("./HeroScene"), { ssr: false });

const REAL = SCENARIOS.filter((s) => s.real);
/** A taste of the campaign for the landing page: the two Traffic Manager cities and the build-your-own interchange. */
const FEATURED_LEVELS = SCENARIOS.filter((s) => ["midtown", "harbor-drive", "highway-interchange"].includes(s.id));

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";
const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL;

/** What the hero "player" does, step by step. `at` = ms after load; the last entry opens the city to traffic. */
const STEPS = [
  { at: 1400, label: "Lay an avenue", caption: "Drag out a road. Two lanes each way." },
  { at: 4200, label: "Add a roundabout + signal", caption: "Junctions decide who waits, and for how long." },
  { at: 7000, label: "Lift a viaduct", caption: "Fly a motorway over the whole city." },
  { at: 10000, label: "Open to traffic", caption: "Every car is simulated. Does it hold up?" },
] as const;

const OPEN_STEP = STEPS.length; // stage value once traffic is live

const subscribeMotion = (cb: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  );
}

function PlayLink({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <Link
      href="/play"
      className={`chunky-btn bg-gradient-to-br from-orange-400 to-pink-500 px-7 py-3.5 text-lg text-white ${className}`}
    >
      {children}
    </Link>
  );
}

function Hero() {
  const heroRef = useRef<HTMLElement>(null);
  const [stage, setStage] = useState(0);
  const [visible, setVisible] = useState(true);
  const reducedMotion = useReducedMotion();
  const webgl = useWebGLSupported();
  const city = getDemoCity();
  const { snapshotRef, stats, failed } = useDemoTraffic(city.full, stage >= OPEN_STEP, visible);

  useEffect(() => {
    const timers = STEPS.map((step, i) =>
      window.setTimeout(() => setStage(i + 1), reducedMotion ? 0 : step.at)
    );
    return () => timers.forEach(window.clearTimeout);
  }, [reducedMotion]);

  // Pause rendering and the sim when the hero is scrolled away or the tab is hidden.
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    let inView = true;
    let tabVisible = !document.hidden;
    const apply = () => setVisible(inView && tabVisible);
    const io = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      apply();
    });
    io.observe(el);
    const onVis = () => {
      tabVisible = !document.hidden;
      apply();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const live = stage >= OPEN_STEP;
  const current = STEPS[Math.min(Math.max(stage, 1), STEPS.length) - 1];
  const showScene = webgl && !failed;

  return (
    <section ref={heroRef} className="relative h-[100svh] min-h-[640px] overflow-hidden">
      {showScene && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <HeroScene stage={stage} snapshotRef={snapshotRef} visible={visible} reducedMotion={reducedMotion} />
        </div>
      )}

      {/* Soft scrim keeps the headline readable wherever the orbiting city drifts. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(255,225,238,0.92) 0%, rgba(255,225,238,0.6) 34%, rgba(255,225,238,0) 62%), linear-gradient(180deg, rgba(255,225,238,0.55) 0%, rgba(255,225,238,0) 22%)",
        }}
      />

      <nav className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-white shadow">
            <IconRoad className="h-5 w-5" />
          </span>
          <span className="font-display text-lg font-extrabold tracking-tight text-[#241b3d]">Road Constructor</span>
          <span className="rounded-full bg-[#241b3d] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-white">
            Beta
          </span>
        </Link>
        <Link href="/play" className="chunky-btn bg-white px-5 py-2 text-sm text-[#241b3d]">
          Play free
        </Link>
      </nav>

      <div className="relative z-10 flex h-full flex-col justify-center px-5 pb-40 pt-24 sm:px-8 lg:px-16">
        <div className="max-w-[52rem]">
          <p
            className="fade-up mb-4 inline-flex items-center gap-2 rounded-full border-2 border-[#2b1c40] bg-white/85 px-3.5 py-1.5 text-xs font-extrabold uppercase tracking-wider text-[#43305f]"
            style={{ animationDelay: "150ms" }}
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Free · Runs in your browser · No sign-up
          </p>
          <h1
            className="font-display fade-up text-balance text-[clamp(2.3rem,4.6vw,4.6rem)] font-extrabold uppercase leading-[0.92] tracking-tight text-[#241b3d]"
            style={{ animationDelay: "300ms" }}
          >
            The city is built.
            <br />
            The traffic is a mess.
            <br />
            <span className="bg-gradient-to-r from-fuchsia-600 via-pink-500 to-orange-500 bg-clip-text text-transparent">
              Make it flow.
            </span>
          </h1>
          <p
            className="fade-up mt-5 max-w-xl text-base font-semibold leading-relaxed text-[#43305f] sm:text-lg"
            style={{ animationDelay: "500ms" }}
          >
            A 3D traffic-management sandbox. Skip the city-building: set lane arrows, speed limits and signal
            timing while every car drives for real, and fix the gridlock live.
          </p>
          <div className="fade-up mt-7 flex flex-wrap items-center gap-4" style={{ animationDelay: "700ms" }}>
            <PlayLink>
              <IconPlay className="h-5 w-5" /> Play now
            </PlayLink>
            <Link
              href="/play?sandbox=1"
              className="chunky-btn bg-white px-5 py-3 text-base text-[#241b3d]"
              title="An empty map and no money limit"
            >
              ♾️ Sandbox
            </Link>
            <a href="#how" className="text-sm font-extrabold text-[#43305f] underline decoration-2 underline-offset-4">
              How it works
            </a>
          </div>
        </div>
      </div>

      {/* The hero "player": a build timeline that narrates what's happening on screen. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center px-4 sm:justify-start sm:px-8 lg:px-16"
        aria-live="polite"
      >
        <div className="hud-panel pointer-events-auto w-full max-w-2xl p-3 sm:p-4">
          <ol className="flex items-center gap-2">
            {STEPS.map((step, i) => {
              const done = stage > i;
              const active = stage === i + 1 && !live;
              return (
                <li key={step.label} className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[#2b1c40] text-xs font-extrabold transition-colors duration-300 ${
                      done ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white" : "bg-[#f1e9ff] text-[#43305f]"
                    }`}
                    style={active ? { animation: "soft-pulse 1.2s ease-in-out infinite" } : undefined}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span
                    className={`hidden truncate text-xs font-extrabold sm:block ${
                      done ? "text-[#241b3d]" : "text-zinc-400"
                    }`}
                  >
                    {step.label}
                  </span>
                  {i < STEPS.length - 1 && <span className="h-0.5 min-w-2 flex-1 rounded bg-[#2b1c40]/15" />}
                </li>
              );
            })}
          </ol>
          <div className="mt-3 flex items-center justify-between gap-3 border-t-2 border-dashed border-[#2b1c40]/15 pt-3">
            <p className="min-w-0 text-sm font-bold text-[#241b3d]">
              {stage === 0 ? "Empty meadow. Let's build a city." : current.caption}
            </p>
            {live && (
              <span className="flex shrink-0 items-center gap-2 rounded-full bg-[#241b3d] px-3 py-1 text-[11px] font-extrabold tabular-nums text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                LIVE · {stats.cars} cars · {Math.round(stats.avgSpeedMph)} mph
              </span>
            )}
          </div>
        </div>
      </div>

      <a
        href="#how"
        aria-label="Scroll to learn more"
        className="absolute bottom-2 left-1/2 z-10 hidden -translate-x-1/2 text-2xl text-[#43305f] sm:block"
        style={{ animation: "nudge-down 1.6s ease-in-out infinite" }}
      >
        ↓
      </a>
    </section>
  );
}

const HOW = [
  {
    icon: IconWarning,
    title: "Find the jam",
    body: "Open a pre-built city to traffic. Flashing markers and a speed heatmap show exactly where it's breaking down.",
    tint: "from-orange-400 to-rose-500",
  },
  {
    icon: IconLanes,
    title: "Change how it flows",
    body: "Set lane arrows, post speed limits, retime signals or swap in a roundabout, all while the cars keep driving.",
    tint: "from-violet-400 to-fuchsia-500",
  },
  {
    icon: IconGauge,
    title: "Watch it work",
    body: "Every change shows up in seconds. Beat the target for speed and throughput to clear the level.",
    tint: "from-emerald-400 to-teal-500",
  },
] as const;

const FEATURES = [
  { icon: IconLanes, title: "Lane arrows", body: "Decide which lanes turn and which go straight. A bad arrow can halve a road's capacity." },
  { icon: IconSpeedSign, title: "Speed limits", body: "One 15 mph block backs up the whole avenue. Find it, fix it, or raise the whole road." },
  { icon: IconSignal, title: "Signal timing", body: "Tune green times per junction or drop the light for priority. Changes apply instantly." },
  { icon: IconHeatmap, title: "Heatmap & jam markers", body: "See where traffic flows and where it dies, in colorblind-safe colors." },
  { icon: IconGauge, title: "Real traffic models", body: "IDM car-following and MOBIL lane changes, the models real traffic engineers use." },
  { icon: IconRoad, title: "Unlimited sandbox", body: "Want to build? An empty map with no money limit: draw roads, bridges, viaducts and roundabouts from scratch." },
  { icon: IconRoad, title: "Bus & bike lanes", body: "A bus carries forty people, a car carries one. Reserve a lane, make streets one-way, add crossings, and watch who it helps." },
  { icon: IconWarning, title: "A living city", body: "Ambulances race through, people cross the road, rain slows everyone down and rush hour comes around on a 24-hour clock." },
  { icon: IconPlay, title: "Play anywhere", body: "Search any place on Earth and play on its real roads, or play on your phone: drag to pan, pinch to zoom, tap to build." },
] as const;

function Sections() {
  return (
    <>
      <section id="how" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <h2 className="font-display text-center text-4xl font-extrabold uppercase tracking-tight text-[#241b3d] sm:text-5xl">
          Find it. Fix it. Flow.
        </h2>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {HOW.map((item, i) => (
            <div key={item.title} className="hud-panel relative p-6">
              <span
                className={`mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border-2 border-[#2b1c40] bg-gradient-to-br text-white ${item.tint}`}
              >
                <item.icon className="h-6 w-6" />
              </span>
              <span className="font-display absolute right-5 top-4 text-5xl font-extrabold text-[#2b1c40]/10">
                {i + 1}
              </span>
              <h3 className="font-display text-2xl font-extrabold uppercase text-[#241b3d]">{item.title}</h3>
              <p className="mt-2 text-sm font-semibold leading-relaxed text-zinc-700">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
        <div className="grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex gap-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-[#2b1c40] bg-[#f1e9ff] text-[#43305f] shadow-[0_3px_0_#2b1c40]">
                <f.icon className="h-5 w-5" />
              </span>
              <div>
                <h3 className="font-display text-lg font-extrabold uppercase text-[#241b3d]">{f.title}</h3>
                <p className="mt-0.5 text-sm font-semibold leading-relaxed text-zinc-700">{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-16 sm:px-8">
        <h2 className="font-display text-3xl font-extrabold uppercase tracking-tight text-[#241b3d] sm:text-4xl">
          Real cities. Real roads.
        </h2>
        <p className="mt-2 max-w-2xl text-sm font-semibold text-zinc-600">
          The actual ramps, lanes, speed limits and traffic lights of six famous places, built from OpenStreetMap. Start
          with the unchanged city and see how much more traffic you can move.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {REAL.map((s) => (
            <div key={s.id} className="hud-panel p-4">
              <span className="text-xs font-extrabold uppercase tracking-wider text-sky-600">🌎 Real roads</span>
              <h3 className="font-display mt-1 text-lg font-extrabold uppercase text-[#241b3d]">{s.name}</h3>
              <p className="mt-1 text-sm font-semibold text-zinc-700">{s.tagline}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] font-semibold text-zinc-500">Map data © OpenStreetMap contributors (ODbL).</p>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
        <h2 className="font-display text-3xl font-extrabold uppercase tracking-tight text-[#241b3d] sm:text-4xl">
          Plus a campaign
        </h2>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {FEATURED_LEVELS.map((s, i) => (
            <div key={s.id} className="hud-panel p-5">
              <span className="text-xs font-extrabold uppercase tracking-wider text-fuchsia-600">Level {i + 1}</span>
              <h3 className="font-display mt-1 text-xl font-extrabold uppercase text-[#241b3d]">{s.name}</h3>
              <p className="mt-1 text-sm font-semibold text-zinc-700">{s.tagline}</p>
              <p className="mt-3 text-xs font-bold text-zinc-500">
                {s.durationS}s · {s.kind === "manage" ? "roads locked" : `$${(s.startingBudget / 1000).toFixed(0)}k budget`}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm font-bold text-zinc-600">
          …and {Math.max(0, SCENARIOS.length - FEATURED_LEVELS.length - REAL.length)} more, from tight little bottlenecks to a grand interchange.
        </p>
      </section>

      <section className="mx-auto max-w-4xl px-5 pb-24 sm:px-8">
        <div className="hud-panel bg-gradient-to-br from-violet-500 to-fuchsia-600 p-8 text-center sm:p-12" style={{ background: "linear-gradient(135deg,#8b5cf6,#d946ef)" }}>
          <h2 className="font-display text-4xl font-extrabold uppercase leading-none text-white sm:text-5xl">
            Your city is jammed. Go fix it.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm font-bold text-white/85">
            Free, in your browser, no account. It&apos;s a beta, so tell me what breaks.
          </p>
          <div className="mt-6">
            <PlayLink>
              <IconPlay className="h-5 w-5" /> Start fixing
            </PlayLink>
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 pb-10 text-xs font-bold text-[#43305f] sm:px-8">
        <span>
          Road Constructor {VERSION && `v${VERSION}`} · built with Next.js, Three.js &amp; a lot of simulated traffic
        </span>
        {FEEDBACK_URL && (
          <a href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
            Send feedback
          </a>
        )}
      </footer>
    </>
  );
}

export default function Landing() {
  return (
    <main className="min-h-screen">
      <Hero />
      <Sections />
    </main>
  );
}
