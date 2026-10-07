"use client";

import type { RunPayout } from "@/lib/career";
import type { ServiceReport } from "@/lib/serviceReport";

function line(label: string, value: string) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="font-semibold text-zinc-500">{label}</span>
      <span className="font-display font-bold tabular-nums text-[#241b3d]">{value}</span>
    </div>
  );
}

/** The results screen's service report: lost time, queues, people, and the medals the run earned (with what each one asked for). */
export default function ServiceReportCard({ report, payout }: { report: ServiceReport; payout?: RunPayout }) {
  const earned = report.medals.filter((m) => m.earned).length;
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl bg-black/[0.03] p-3 text-left">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-zinc-500">Service report</span>
        <span className="text-[10.5px] font-bold text-amber-600">
          {earned} of {report.medals.length} medals
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {report.avgDelayS !== null && line("Time lost per trip", `${report.avgDelayS.toFixed(0)} s`)}
        {report.delayShare !== null && line("Trips took", `${Math.round(report.delayShare * 100)}% longer than an empty road`)}
        {line("Longest queue", `${Math.round(report.queuePeakFt)} ft`)}
        {report.pedServed > 0 && line("People crossing", `${report.pedServed}${report.pedIncidents > 0 ? ` · ${report.pedIncidents} stepped into traffic` : ""}`)}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {report.medals.map((m) => (
          <span
            key={m.id}
            title={m.detail}
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${m.earned ? "bg-amber-400/25 text-amber-800" : "bg-black/5 text-zinc-400"}`}
          >
            {m.icon} {m.label}
          </span>
        ))}
      </div>
      <ul className="flex flex-col gap-0.5">
        {report.medals.map((m) => (
          <li key={m.id} className={`text-[10.5px] leading-snug ${m.earned ? "text-zinc-600" : "text-zinc-400"}`}>
            {m.earned ? "✓" : "·"} {m.detail}
          </li>
        ))}
      </ul>
      {payout && (
        <div className="flex items-center justify-between rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-bold text-emerald-800">
          <span>
            City funds
            {payout.newStars > 0 || payout.newMedals > 0 ? ` · ${payout.newStars > 0 ? `${payout.newStars} new star${payout.newStars > 1 ? "s" : ""}` : ""}${payout.newStars > 0 && payout.newMedals > 0 ? ", " : ""}${payout.newMedals > 0 ? `${payout.newMedals} new medal${payout.newMedals > 1 ? "s" : ""}` : ""}` : " · replay"}
          </span>
          <span className="tabular-nums">+${payout.funds.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
