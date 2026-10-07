"use client";

import { useMemo } from "react";
import { STARTING_BUDGET, isSandboxBudget, useEditorStore } from "@/state/editorStore";
import { economyRates } from "@/sim/economy";
import { getScenarioById } from "@/sim/scenarios";

function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

export default function BudgetBar() {
  const budget = useEditorStore((s) => s.budget);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const economyK = useEditorStore((s) => s.economyK);
  const tollEarned = useEditorStore((s) => s.tollEarned);
  // Net running cost per simulated minute: upkeep out, parking in. Hidden where money doesn't run out.
  const perMinute = useMemo(() => {
    if (economyK === null || edges.length === 0) return null;
    const r = economyRates(nodes, edges, economyK);
    return (r.income - r.upkeep) * 60;
  }, [nodes, edges, economyK]);
  // Campaign levels start from their own budget, not the free-build default.
  const cap = useEditorStore((s) => (s.activeScenarioId ? getScenarioById(s.activeScenarioId)?.startingBudget : undefined)) ?? STARTING_BUDGET;
  const top = Math.max(cap, budget);
  const fraction = Math.min(1, Math.max(0, (top - budget) / top));

  if (isSandboxBudget(budget)) {
    return (
      <div className="pointer-events-none absolute right-[4.75rem] top-4 z-20 max-md:right-2 max-md:top-[3.9rem]">
        <div className="hud-panel flex items-center gap-2 rounded-2xl px-4 py-2.5 max-md:px-3 max-md:py-1.5">
          <span className="font-display text-2xl font-extrabold leading-none text-emerald-600 max-md:text-xl">∞</span>
          <div className="flex flex-col leading-tight max-md:hidden">
            <span className="font-display text-sm font-extrabold uppercase text-[#241b3d]">Sandbox</span>
            <span className="text-[10.5px] font-semibold text-zinc-500">No money limit</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute right-[4.75rem] top-4 z-20 max-md:right-2 max-md:top-[3.9rem]">
      <div className="hud-panel flex flex-col gap-1 rounded-2xl px-4 py-2 max-md:px-3 max-md:py-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className={`font-display text-lg font-extrabold tabular-nums ${budget < 0 ? "text-red-600" : "text-[#241b3d]"}`}
          >
            {formatMoney(budget)}
          </span>
          <span className="text-xs font-semibold text-zinc-500">/ {formatMoney(top)}</span>
        </div>
        {perMinute !== null && Math.abs(perMinute) >= 1 && (
          <span className={`text-[10px] font-bold tabular-nums ${perMinute < 0 ? "text-red-600" : "text-emerald-600"}`} title="Upkeep on your roads, less parking income, per minute of traffic">
            {perMinute < 0 ? "−" : "+"}${Math.abs(Math.round(perMinute)).toLocaleString()}/min upkeep
          </span>
        )}
        {tollEarned >= 1 && (
          <span className="text-[10px] font-bold tabular-nums text-emerald-600" title="Tolls paid by cars in the express lane this run">
            +${Math.round(tollEarned).toLocaleString()} tolls
          </span>
        )}
        <div className="h-1.5 w-40 max-md:w-28 overflow-hidden rounded-full bg-black/10">
          <div
            className={`h-full rounded-full transition-all ${
              fraction >= 1 ? "bg-red-500" : "bg-gradient-to-r from-orange-400 via-pink-500 to-fuchsia-500"
            }`}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
