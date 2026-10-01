"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useEditorStore } from "@/state/editorStore";
import { lowerQuality, setQuality, useQuality } from "@/lib/quality";

const WINDOW_SECONDS = 4;
const MIN_FPS = 24;

/**
 * Watches render frame rate while traffic is running and, if it stays below
 * MIN_FPS for a full window, steps down one quality tier (high -> medium -> low). Lives inside the Canvas
 * to reuse its frame loop; renders nothing.
 */
export default function PerfGuard({ active }: { active: boolean }) {
  const quality = useQuality();
  const mode = useEditorStore((s) => s.mode);
  const elapsed = useRef(0);
  const frames = useRef(0);

  useFrame((_, delta) => {
    // `active` matters: while paused the limiter deliberately idles at a few fps, which is not a slow machine.
    if (quality === "low" || mode !== "simulate" || !active || delta > 0.5) {
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
    if (fps < MIN_FPS) setQuality(lowerQuality(quality), true);
  });

  return null;
}
