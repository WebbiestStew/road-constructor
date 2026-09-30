"use client";

import { dismissAutoNotice, setQuality, useAutoDowngraded } from "@/lib/quality";

export default function QualityNotice() {
  const show = useAutoDowngraded();
  if (!show) return null;
  return (
    <div className="pointer-events-auto absolute left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full px-4 py-2 text-xs font-bold hud-panel">
      <span>Running slowly — switched to Low graphics.</span>
      <button type="button" onClick={() => setQuality("high")} className="text-violet-700 underline">
        Undo
      </button>
      <button type="button" onClick={dismissAutoNotice} aria-label="Dismiss" className="text-zinc-500">
        ✕
      </button>
    </div>
  );
}
