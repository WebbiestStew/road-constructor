"use client";

import { STARTING_BUDGET, isSandboxBudget, useEditorStore } from "@/state/editorStore";
import { getScenarioById } from "@/sim/scenarios";

function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

export default function BudgetBar() {
  const budget = useEditorStore((s) => s.budget);
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
