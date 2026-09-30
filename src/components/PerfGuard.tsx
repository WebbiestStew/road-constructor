"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useEditorStore } from "@/state/editorStore";
import { setQuality, useQuality } from "@/lib/quality";

const WINDOW_SECONDS = 4;
const MIN_FPS = 24;

/**
 * Watches render frame rate while traffic is running and, if it stays below
 * MIN_FPS for a full window, drops to low quality once. Lives inside the Canvas
 * to reuse its frame loop; renders nothing.
 */
export default function PerfGuard() {
  const quality = useQuality();
  const mode = useEditorStore((s) => s.mode);
  const elapsed = useRef(0);
  const frames = useRef(0);

  useFrame((_, delta) => {
    if (quality === "low" || mode !== "simulate" || delta > 0.5) {
      // Ignore tab-switch stalls and anything outside a running sim.
      elapsed.current = 0;
      frames.current = 0;
      return;
    }
    elapsed.current += delta;
    frames.current += 1;
    if (elapsed.current < WINDOW_SECONDS) return;
    const fps = frames.current / elapsed.current;
    elapsed.current = 0;
    frames.current = 0;
    if (fps < MIN_FPS) setQuality("low", true);
  });

  return null;
}
