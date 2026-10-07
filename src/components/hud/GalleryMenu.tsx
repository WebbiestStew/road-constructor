"use client";

import { useCallback, useEffect, useState } from "react";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import { fetchLevel, likeLevel, listLevels, notePlayed, reportLevel, type GalleryEntry } from "@/lib/gallery";
import { setGalleryOpen } from "@/lib/galleryMenu";
import { requestPublish, setActiveChallenge } from "@/lib/challenge";
import { buildPublishedScenario } from "@/sim/scenarios";
import { pushToast } from "@/lib/toast";

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** The community gallery: levels other players published, with the score their unchanged city moves. Play one, like it, or report it. */
export default function GalleryMenu({ runner }: { runner: UseScenarioRunnerReturn }) {
  const [sort, setSort] = useState<"new" | "top">("new");
  const [levels, setLevels] = useState<GalleryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [liked, setLiked] = useState<Set<string>>(new Set());

  const load = useCallback(async (nextSort: "new" | "top", offset = 0) => {
    const r = await listLevels(nextSort, offset);
    if ("error" in r) {
      setError(r.error);
      setLevels((cur) => cur ?? []);
      return;
    }
    setError("");
    setLevels((cur) => (offset === 0 ? r.levels : [...(cur ?? []), ...r.levels]));
    setMore(r.more);
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setLevels(null);
      void load(sort);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setGalleryOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [sort, load]);

  const play = async (entry: GalleryEntry) => {
    setBusy(entry.id);
    const level = await fetchLevel(entry.id);
    setBusy(null);
    if ("error" in level) {
      pushToast(level.error, "bad");
      return;
    }
    const key = `g${entry.id}`;
    const def = buildPublishedScenario({
      key,
      name: level.name,
      network: level.network,
      baseline: level.baseline,
      service: level.delayShare !== undefined && level.queueFt !== undefined ? { delayShare: level.delayShare, queueFt: level.queueFt } : undefined,
      mix: { bus: level.bus ?? 0, bike: level.bike ?? 0 },
      from: level.from,
    });
    notePlayed(entry.id);
    setGalleryOpen(false);
    setActiveChallenge(null);
    runner.startScenario(def);
  };

  const like = async (entry: GalleryEntry) => {
    if (liked.has(entry.id)) return;
    const r = await likeLevel(entry.id);
    if (typeof r === "number") {
      setLiked((s) => new Set(s).add(entry.id));
      setLevels((cur) => (cur ?? []).map((l) => (l.id === entry.id ? { ...l, likes: r } : l)));
    } else pushToast(r.error, "bad");
  };

  const report = async (entry: GalleryEntry) => {
    if (!window.confirm(`Report “${entry.name}” as inappropriate or broken? Three reports hide a level.`)) return;
    const r = await reportLevel(entry.id);
    pushToast(r === true ? "Thanks: we've noted it" : r.error, r === true ? "info" : "bad");
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[64] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Community levels"
      onClick={(e) => e.target === e.currentTarget && setGalleryOpen(false)}
    >
      <div className="hud-panel flex max-h-[88vh] w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-3xl p-5 hud-scrollbar">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-extrabold uppercase text-[#241b3d]">🌐 Community levels</h2>
          <button type="button" onClick={() => setGalleryOpen(false)} className="rounded-full bg-black/5 px-3 py-1.5 text-xs font-bold text-zinc-700 hover:bg-black/10">
            Done
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1 rounded-xl bg-black/5 p-1">
            {(["new", "top"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sort === s}
                onClick={() => setSort(s)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-bold ${sort === s ? "bg-white text-[#241b3d] shadow" : "text-zinc-500 hover:text-zinc-800"}`}
              >
                {s === "new" ? "Newest" : "Most liked"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setGalleryOpen(false);
              requestPublish();
            }}
            className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 px-3 py-2 text-xs font-bold text-white shadow-sm hover:brightness-110 active:scale-95"
          >
            📤 Post my city
          </button>
        </div>
        <p className="text-[11px] font-semibold leading-snug text-zinc-500">
          Every level carries the score its own author&apos;s unchanged city moved, measured in their browser: beat it to earn stars. Levels are posted by players, not checked by us: report anything that shouldn&apos;t be here.
        </p>
        {error && <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-800">{error}</p>}
        {levels === null ? (
          <p className="text-sm font-semibold text-zinc-500">Loading…</p>
        ) : levels.length === 0 && !error ? (
          <p className="px-1 text-sm font-semibold text-zinc-500">Nothing here yet. Build a city, then press Publish, and post it.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {levels.map((l) => (
              <li key={l.id} className="flex flex-col gap-1.5 rounded-2xl border border-black/10 bg-white p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-display text-sm font-extrabold text-[#241b3d]">{l.name}</span>
                  <span className="shrink-0 text-[10.5px] font-semibold text-zinc-400">{ago(l.at)}</span>
                </div>
                <span className="text-[11px] font-semibold text-zinc-500">
                  by {l.from} · {l.roads} roads · unchanged city moves {l.baseline} · {l.plays} plays
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={busy === l.id}
                    onClick={() => void play(l)}
                    className="rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 px-3 py-1 text-[11px] font-bold text-white shadow-sm hover:brightness-110 active:scale-95 disabled:opacity-50"
                  >
                    {busy === l.id ? "Opening…" : "▶ Play"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void like(l)}
                    disabled={liked.has(l.id)}
                    className="rounded-full bg-black/5 px-3 py-1 text-[11px] font-bold text-zinc-700 hover:bg-black/10 active:scale-95 disabled:text-rose-600"
                  >
                    {liked.has(l.id) ? "♥" : "♡"} {l.likes}
                  </button>
                  <button type="button" onClick={() => void report(l)} className="rounded-full px-3 py-1 text-[11px] font-bold text-zinc-400 hover:text-red-600">
                    Report
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {more && (
          <button type="button" onClick={() => void load(sort, levels?.length ?? 0)} className="self-center rounded-full bg-black/5 px-4 py-1.5 text-xs font-bold text-zinc-700 hover:bg-black/10">
            Show more
          </button>
        )}
      </div>
    </div>
  );
}
