"use client";

import { useEffect, useState } from "react";
import { isTouchOnlyNarrowViewport } from "@/lib/deviceCheck";
import { IconRoad } from "./icons";

/**
 * A full-screen "this won't work well here" card for touch-only phones —
 * the game leans on right-drag orbit, middle-drag pan, scroll zoom, and a
 * dozen keyboard hotkeys, none of which a phone can offer. Re-checks on
 * resize/orientation change so it also reacts correctly to devtools'
 * responsive-mode toggling, not just the initial load.
 */
export default function MobileBlockerModal() {
  const [blocked, setBlocked] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const check = () => setBlocked(isTouchOnlyNarrowViewport());
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  if (!blocked || dismissed) return null;

  return (
    <div className="pointer-events-auto fixed inset-0 z-[70] flex items-center justify-center bg-[#241b3d] p-6 text-center">
      <div className="hud-panel flex max-w-xs flex-col items-center gap-4 rounded-3xl p-7">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-lg">
          <IconRoad className="h-8 w-8" />
        </span>
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-lg font-extrabold text-[#241b3d]">Desktop Recommended</h2>
          <p className="text-[13px] leading-snug text-zinc-600">
            Road Constructor requires keyboard and multi-button mouse controls — right-drag to orbit, middle-drag to
            pan, scroll to zoom, plus hotkeys for drawing. Pull it up on a desktop or laptop for the real experience.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-xl bg-black/5 px-4 py-2 text-xs font-bold text-zinc-600 transition hover:bg-black/10 active:scale-95"
        >
          Continue anyway
        </button>
      </div>
    </div>
  );
}
