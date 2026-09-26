"use client";

import { STARTING_BUDGET, useEditorStore } from "@/state/editorStore";

function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

export default function BudgetBar() {
  const budget = useEditorStore((s) => s.budget);
  const spent = STARTING_BUDGET - budget;
  const fraction = Math.min(1, Math.max(0, spent / STARTING_BUDGET));

  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-20 -translate-x-1/2">
      <div className="hud-panel flex flex-col gap-1 rounded-2xl px-4 py-2">
        <div className="flex items-baseline gap-1.5 text-sm">
          <span className={`font-bold tabular-nums ${budget < 0 ? "text-red-600" : "text-zinc-900"}`}>
            {formatMoney(budget)}
          </span>
          <span className="text-xs text-zinc-500">/ {formatMoney(STARTING_BUDGET)}</span>
        </div>
        <div className="h-1 w-40 overflow-hidden rounded-full bg-black/10">
          <div
            className={`h-full rounded-full ${fraction >= 1 ? "bg-red-500" : "bg-zinc-800"}`}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
