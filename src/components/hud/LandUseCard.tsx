"use client";

import { LAND_USE_KINDS, HOME_DEMAND_VPH, landUseCost } from "@/sim/landUse";
import { isSandboxBudget, useEditorStore } from "@/state/editorStore";

/** The land-use tool's panel: what to place, how big, and what it does to the traffic. */
export default function LandUseCard() {
  const kind = useEditorStore((s) => s.landUseKind);
  const size = useEditorStore((s) => s.landUseSize);
  const setKind = useEditorStore((s) => s.setLandUseKind);
  const setSize = useEditorStore((s) => s.setLandUseSize);
  const count = useEditorStore((s) => s.landUse.length);
  const free = useEditorStore((s) => isSandboxBudget(s.budget));
  const reattach = useEditorStore((s) => s.reattachLandUse);
  const current = LAND_USE_KINDS.find((k) => k.id === kind)!;
  return (
    <div className="hud-panel flex w-72 max-w-[calc(50vw-1.5rem)] flex-col gap-2.5 rounded-2xl p-3.5">
      <span className="font-display text-sm font-extrabold uppercase text-[#241b3d]">🏘️ Land use</span>
      <div className="grid grid-cols-3 gap-1.5">
        {LAND_USE_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            aria-pressed={kind === k.id}
            onClick={() => setKind(k.id)}
            className={`flex flex-col items-center gap-0.5 rounded-xl py-2 text-[11px] font-bold transition active:scale-95 ${kind === k.id ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm" : "bg-black/5 text-zinc-600 hover:bg-black/10"}`}
          >
            <span className="text-lg leading-none">{k.emoji}</span>
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-extrabold uppercase tracking-wide text-zinc-400">Size</span>
        {([1, 2, 3] as const).map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={size === n}
            onClick={() => setSize(n)}
            className={`flex-1 rounded-lg py-1.5 text-xs font-bold ${size === n ? "bg-[#241b3d] text-white" : "bg-black/5 text-zinc-600 hover:bg-black/10"}`}
          >
            {n === 1 ? "Small" : n === 2 ? "Medium" : "Large"}
          </button>
        ))}
      </div>
      <p className="text-[11.5px] font-semibold leading-snug text-zinc-600">
        {current.blurb} {kind === "home" ? `A ${["", "small", "medium", "large"][size]} one sends about ${HOME_DEMAND_VPH[size]} cars an hour.` : ""} {free ? "" : `$${landUseCost(kind, size).toLocaleString()}.`}
      </p>
      <p className="text-[11px] leading-snug text-zinc-500">Click the ground within a block of a road. Roads that already have an Entry or Destination from the Zone tool are left alone. {count} placed.</p>
      {count > 0 && (
        <button type="button" onClick={reattach} className="self-start rounded-full bg-black/5 px-3 py-1 text-[11px] font-bold text-zinc-700 hover:bg-black/10">
          ↻ Re-attach to the roads
        </button>
      )}
    </div>
  );
}
