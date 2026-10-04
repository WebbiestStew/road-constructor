"use client";

import { useEffect, useRef, useState } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { playComboChime } from "@/lib/sound";

const COMBO_POINTS = 500;
const SHOW_MS = 2600;

/** "+500 FLOW COMBO!": flashes in green, with a chime, each time a platoon rolls through back-to-back signals without slowing. */
export default function FlowComboBanner({ sim }: { sim: UseTrafficSimulationReturn }) {
  const combos = sim.metrics.combos;
  const last = useRef(0);
  const [shown, setShown] = useState<{ n: number; key: number } | null>(null);

  useEffect(() => {
    // A restart takes the count back to zero.
    if (combos < last.current) last.current = combos;
    if (combos > last.current) {
      last.current = combos;
      playComboChime(combos);
      const raf = requestAnimationFrame(() => setShown({ n: combos, key: combos }));
      const hide = window.setTimeout(() => setShown(null), SHOW_MS);
      return () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(hide);
      };
    }
  }, [combos]);

  if (!shown) return null;
  return (
    <div key={shown.key} className="animate-pop pointer-events-none absolute left-1/2 top-[38%] z-30 -translate-x-1/2 text-center">
      <div className="font-display text-4xl font-black uppercase tracking-tight text-emerald-300 drop-shadow-[0_3px_0_#064e3b] sm:text-5xl">+{COMBO_POINTS} Flow combo!</div>
      <div className="mt-1 text-sm font-extrabold uppercase tracking-widest text-white drop-shadow">
        A green wave · combo ×{shown.n} · {shown.n * COMBO_POINTS} pts
      </div>
    </div>
  );
}
