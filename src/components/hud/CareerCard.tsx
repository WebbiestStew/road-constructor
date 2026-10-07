"use client";

import { useState } from "react";
import { MAX_TRANSFER, careerPoints, rankFor, useCareer, withdrawFunds } from "@/lib/career";
import { totalStars, useProgress } from "@/lib/progress";
import { useEditorStore } from "@/state/editorStore";
import { pushToast } from "@/lib/toast";

/** Rank, city funds and medals, with the funds' one use: paying into a free-build city. Sits at the top of the level picker. */
export default function CareerCard() {
  const career = useCareer();
  const stars = totalStars(useProgress());
  const points = careerPoints(career, stars);
  const { rank, next } = rankFor(points);
  const medalCount = Object.values(career.medals).reduce((n, list) => n + list.length, 0);
  const inFreeBuild = useEditorStore((s) => !s.activeScenarioId && s.budget < 5e8);
  const addBudget = useEditorStore((s) => s.addFreeBuildBudget);
  const [open, setOpen] = useState(false);

  const transfer = (amount: number) => {
    const take = withdrawFunds(amount);
    if (take <= 0) return;
    if (addBudget(take)) pushToast(`💰 $${take.toLocaleString()} moved from city funds into this city's budget`, "good");
    else pushToast("Funds can only go into a free-build city", "alert");
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border-2 border-amber-300/70 bg-amber-50 p-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center justify-between gap-2 text-left">
        <span className="flex flex-col">
          <span className="font-display text-sm font-extrabold uppercase text-[#3b2410]">🏛️ Career · {rank.name}</span>
          <span className="text-[11px] font-semibold text-[#3b2410]/70">
            {stars} ★ · {medalCount} medals{next ? ` · ${next.points - points} more to ${next.name}` : " · top rank"}
          </span>
        </span>
        <span className="font-display text-base font-extrabold tabular-nums text-emerald-700">${career.funds.toLocaleString()}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 text-[11px] text-[#3b2410]/80">
          <p className="leading-snug">
            Winning a level pays city funds: $1,000 for each new star, $400 for each new medal, $100 for a replay. {career.earned.toLocaleString()} earned so far over {career.runs} wins.
          </p>
          {inFreeBuild ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold">Fund this city:</span>
              {[100_000, 250_000, MAX_TRANSFER].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  disabled={career.funds < amt}
                  onClick={() => transfer(amt)}
                  className="rounded-full bg-emerald-600 px-2.5 py-1 font-bold text-white transition enabled:hover:brightness-110 disabled:opacity-40"
                >
                  +${amt >= 1e6 ? `${amt / 1e6}M` : `${amt / 1000}k`}
                </button>
              ))}
              {career.funds > 0 && career.funds < 100_000 && (
                <button type="button" onClick={() => transfer(career.funds)} className="rounded-full bg-emerald-600 px-2.5 py-1 font-bold text-white hover:brightness-110">
                  All ${career.funds.toLocaleString()}
                </button>
              )}
            </div>
          ) : (
            <p className="font-semibold">Leave the level (free-build) to spend funds on a city of your own.</p>
          )}
        </div>
      )}
    </div>
  );
}
