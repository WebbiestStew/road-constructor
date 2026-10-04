"use client";

import { useEffect, useRef } from "react";
import { usePanic } from "@/lib/panic";
import { playAlertSiren } from "@/lib/sound";

/** The red warning banner with a countdown. The siren sounds once when a new alert appears. */
export default function PanicBanner() {
  const panic = usePanic();
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    if (!panic) {
      lastId.current = null;
      return;
    }
    if (panic.id !== lastId.current) {
      lastId.current = panic.id;
      playAlertSiren();
    }
  }, [panic]);

  if (!panic) return null;
  const s = Math.max(0, Math.ceil(panic.secondsLeft));
  return (
    <div className="pointer-events-none absolute left-1/2 top-24 z-30 w-[min(34rem,92vw)] -translate-x-1/2 max-md:top-28">
      <div className="animate-warn-pulse flex items-center gap-3 rounded-2xl border-[3px] border-white bg-gradient-to-r from-red-700 via-red-600 to-red-700 px-4 py-2.5 text-white shadow-[0_6px_0_#7f1d1d,0_0_30px_rgba(239,68,68,0.6)]">
        <span className="text-2xl leading-none">🚨</span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-[13px] font-extrabold uppercase leading-tight tracking-wide sm:text-sm">{panic.text}</div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-red-100/90">{s > 0 ? `Arrives in ${s}s: retime signals, change limits` : "Here it comes"}</div>
        </div>
        <span className="font-display flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-xl font-black tabular-nums text-red-700">{s}</span>
      </div>
    </div>
  );
}
