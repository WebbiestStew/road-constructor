"use client";

import { useEffect } from "react";
import { useCompact } from "@/lib/compact";
import { pushToast } from "@/lib/toast";

const SEEN_KEY = "road-constructor:touch-tip:v1";

/** One-time gesture cheat sheet on phones; the game itself plays fine without a mouse or keyboard. */
export default function TouchTip() {
  const compact = useCompact();
  useEffect(() => {
    if (!compact) return;
    try {
      if (localStorage.getItem(SEEN_KEY)) return;
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* private mode: show it every time rather than never */
    }
    const t = setTimeout(() => pushToast("👆 Drag to pan · pinch to zoom · twist with two fingers to rotate · tap to build", "info"), 1500);
    return () => clearTimeout(t);
  }, [compact]);
  return null;
}
