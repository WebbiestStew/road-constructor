"use client";

import { useEffect, useRef, useState } from "react";
import { loadPlace, searchPlaces, type PlaceHit } from "@/lib/place";
import type { NetworkSnapshot } from "@/sim/types";
import type { SceneryData } from "@/sim/osm/scenery";

type Phase = { kind: "idle" } | { kind: "searching" } | { kind: "loading"; name: string } | { kind: "error"; message: string };

/** "Load any place": type a place, pick a result, and play on its real roads. */
export default function PlaceSearch({ onPlace }: { onPlace: (network: NetworkSnapshot, name: string, scenery: SceneryData) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const search = async () => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPhase({ kind: "searching" });
    try {
      const found = await searchPlaces(query, ctl.signal);
      setHits(found);
      setPhase(found.length === 0 ? { kind: "error", message: "No places found. Try a city or a landmark." } : { kind: "idle" });
    } catch (e) {
      if (!ctl.signal.aborted) setPhase({ kind: "error", message: e instanceof Error ? e.message : "Search failed." });
    }
  };

  const open = async (hit: PlaceHit) => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const short = hit.name.split(",").slice(0, 2).join(",").trim();
    setPhase({ kind: "loading", name: short });
    try {
      const { network, scenery } = await loadPlace(hit, ctl.signal);
      onPlace(network, short, scenery);
    } catch (e) {
      if (!ctl.signal.aborted) setPhase({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load that place." });
    }
  };

  const busy = phase.kind === "searching" || phase.kind === "loading";

  return (
    <div className="flex flex-col gap-2 rounded-2xl border-[3px] border-[#241b3d] bg-gradient-to-br from-sky-200 to-cyan-300 p-3.5 shadow-[0_4px_0_#241b3d]">
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none">🌍</span>
        <span className="font-display text-sm font-extrabold uppercase text-[#241b3d]">Load any place</span>
      </div>
      <p className="text-[11.5px] font-semibold leading-snug text-[#241b3d]/75">
        Type a city or a landmark and play on a square mile of its real roads, with unlimited money.
      </p>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void search();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Try “Spaghetti Junction, Atlanta”"
          className="min-w-0 flex-1 rounded-lg border-2 border-[#241b3d]/40 bg-white/90 px-2.5 py-1.5 text-xs font-semibold text-[#241b3d] outline-none placeholder:text-zinc-400 focus:border-[#241b3d]"
        />
        <button
          type="submit"
          disabled={busy || query.trim().length < 3}
          className="rounded-lg border-2 border-[#241b3d] bg-[#241b3d] px-3 py-1.5 text-xs font-bold text-white transition active:scale-95 disabled:opacity-40"
        >
          Search
        </button>
      </form>
      {phase.kind === "searching" && <p className="text-[11px] font-bold text-[#241b3d]/70">Searching…</p>}
      {phase.kind === "loading" && <p className="text-[11px] font-bold text-[#241b3d]/70">Downloading the roads around {phase.name}… this takes a few seconds.</p>}
      {phase.kind === "error" && <p className="text-[11px] font-bold text-red-700">{phase.message}</p>}
      {hits.length > 0 && phase.kind !== "loading" && (
        <ul className="flex flex-col gap-1">
          {hits.map((h) => (
            <li key={`${h.lat},${h.lon}`}>
              <button
                type="button"
                onClick={() => void open(h)}
                className="w-full truncate rounded-lg bg-white/70 px-2.5 py-1.5 text-left text-[11.5px] font-semibold text-[#241b3d] transition hover:bg-white active:scale-[0.99]"
                title={h.name}
              >
                📍 {h.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[9.5px] font-semibold leading-snug text-[#241b3d]/60">
        Uses OpenStreetMap&apos;s search and map servers from your browser. Roads © OpenStreetMap contributors (ODbL).
      </p>
    </div>
  );
}
