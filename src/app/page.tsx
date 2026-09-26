import Link from "next/link";
import type { ComponentType, SVGProps } from "react";
import {
  IconCar,
  IconClock,
  IconDraw,
  IconFlag,
  IconGauge,
  IconHeatmap,
  IconRoad,
  IconRoundabout,
  IconUndo,
  IconWarning,
} from "@/components/hud/icons";

interface Feature {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
  gradient: string;
}

const FEATURES: Feature[] = [
  {
    icon: IconDraw,
    title: "Draw & zone",
    body: "Sketch roads, tap in junctions, mark entries and destinations — a full build toolkit, no menus buried three levels deep.",
    gradient: "from-violet-500 to-fuchsia-600",
  },
  {
    icon: IconGauge,
    title: "Real car-following physics",
    body: "Every vehicle runs on the Intelligent Driver Model plus MOBIL lane-changing — not a scripted flow, an actual microscopic simulation.",
    gradient: "from-emerald-400 to-teal-500",
  },
  {
    icon: IconRoundabout,
    title: "Signals & roundabouts",
    body: "Junctions default to priority yielding, or convert one to a signal or a roundabout when priority alone can't cut it.",
    gradient: "from-amber-400 to-orange-500",
  },
  {
    icon: IconWarning,
    title: "Problem markers",
    body: "Sustained gridlock gets flagged with a pulsing marker right on the map, plus an optional speed heatmap — no digging through stats.",
    gradient: "from-orange-400 to-red-500",
  },
  {
    icon: IconFlag,
    title: "Campaign scenarios",
    body: "Three built-in timed challenges with a budget and a scoring formula. Nothing scores itself — each one needs a real fix.",
    gradient: "from-sky-400 to-blue-500",
  },
  {
    icon: IconUndo,
    title: "Undo, save, export",
    body: "Full undo/redo history, autosave, and JSON export/import for backing up or sharing a network you're proud of.",
    gradient: "from-pink-500 to-rose-500",
  },
];

const ALPHA_NOTES = [
  "No touch/mobile support yet — built for mouse + keyboard.",
  "One autosave slot; export to JSON before trying something risky.",
  "Lane assignment at diverges is automatic, not a freeform editor.",
];

function MiniRoadPreview() {
  return (
    <div className="relative flex h-40 w-full items-center justify-center overflow-hidden rounded-2xl bg-[#3a4155] sm:h-48">
      <div className="absolute inset-x-0 top-1/2 h-10 -translate-y-1/2 bg-[#3a4155]" />
      <div className="absolute inset-x-6 top-1/2 h-[2px] -translate-y-1/2 bg-[repeating-linear-gradient(90deg,#f4f4f5_0px,#f4f4f5_18px,transparent_18px,transparent_34px)]" />
      {[
        { left: "12%", color: "#3b82f6" },
        { left: "34%", color: "#eab308" },
        { left: "58%", color: "#3b82f6" },
        { left: "78%", color: "#ef4444" },
      ].map((car, i) => (
        <span
          key={i}
          className="absolute top-1/2 h-3.5 w-7 -translate-y-1/2 rounded-sm shadow-md"
          style={{ left: car.left, background: car.color }}
        />
      ))}
    </div>
  );
}

function FeatureCard({ icon: Icon, title, body, gradient }: Feature) {
  return (
    <div className="hud-panel flex flex-col gap-3 rounded-2xl p-5">
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${gradient}`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <h3 className="font-display text-base font-bold text-[#241b3d]">{title}</h3>
      <p className="text-sm leading-snug text-zinc-600">{body}</p>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen w-full overflow-x-hidden">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 pt-6 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="hover-wiggle flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-white shadow-sm">
            <IconRoad className="h-5 w-5" />
          </span>
          <span className="font-display text-lg font-extrabold tracking-tight text-[#241b3d]">
            Road Constructor
          </span>
        </div>
        <Link
          href="/play"
          className="rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95 sm:text-sm"
        >
          Launch app →
        </Link>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-20 px-5 pb-24 pt-16 sm:px-8 sm:pt-24">
        <section className="flex flex-col items-start gap-6">
          <span className="animate-pop rounded-full bg-black/[0.06] px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-zinc-600">
            🚧 Early alpha — expect rough edges
          </span>
          <h1 className="font-display max-w-2xl text-4xl font-extrabold leading-[1.05] tracking-tight text-[#241b3d] sm:text-6xl">
            Build roads. Open to traffic. See if it holds up.
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-zinc-600 sm:text-lg">
            A 3D traffic-engineering sandbox — draw a road network, mark where cars enter and
            where they&rsquo;re headed, then watch a real microscopic simulation decide whether your
            design actually works.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/play"
              className="animate-idle-pulse rounded-2xl border-2 border-[#2b1c40] bg-gradient-to-br from-emerald-400 to-green-500 px-6 py-3.5 text-sm font-bold text-white shadow-[0_4px_0_#145c3d] transition hover:-translate-y-0.5 hover:shadow-[0_6px_0_#145c3d] active:translate-y-1 active:shadow-[0_1px_0_#145c3d] sm:text-base"
            >
              Launch the sandbox →
            </Link>
            <span className="text-xs text-zinc-500 sm:text-sm">
              Free, runs in your browser, no account needed.
            </span>
          </div>
          <div className="w-full max-w-2xl pt-2">
            <MiniRoadPreview />
          </div>
        </section>

        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h2 className="font-display text-2xl font-extrabold text-[#241b3d] sm:text-3xl">
              What&rsquo;s in the box
            </h2>
            <p className="text-sm text-zinc-500 sm:text-base">
              Everything below is live in this build — not a roadmap.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <FeatureCard key={f.title} {...f} />
            ))}
          </div>
        </section>

        <section className="hud-panel flex flex-col gap-4 rounded-2xl p-6 sm:p-8">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm">
              <IconClock className="h-5 w-5" />
            </span>
            <h2 className="font-display text-xl font-extrabold text-[#241b3d]">
              This is an alpha, honestly
            </h2>
          </div>
          <p className="text-sm leading-relaxed text-zinc-600 sm:text-base">
            The core sandbox, campaign scenarios, and traffic physics are solid and worth
            playing with — but it&rsquo;s a young project. A few known gaps:
          </p>
          <ul className="flex flex-col gap-2">
            {ALPHA_NOTES.map((note) => (
              <li key={note} className="flex items-start gap-2.5 text-sm text-zinc-600 sm:text-base">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
                {note}
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <IconCar className="h-4 w-4" />
            <IconGauge className="h-4 w-4" />
            <IconFlag className="h-4 w-4" />
            <IconHeatmap className="h-4 w-4" />
            <span className="ml-1">IDM + MOBIL · Three.js · React Three Fiber</span>
          </div>
          <Link
            href="/play"
            className="rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            Launch app →
          </Link>
        </section>
      </main>
    </div>
  );
}
