"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useEditorStore } from "@/state/editorStore";
import { lowerQuality, setQuality, useQuality } from "@/lib/quality";
import { getDetailShed, setDetailShed } from "@/lib/perfDetail";
import { noteGuardEvent } from "@/lib/deviceReport";

const WINDOW_SECONDS = 4;
const MIN_FPS = 24;
/** Below this the optional overlays start to run at a lower rate, and above SMOOTH_FPS for a while they come back. */
const SHED_FPS = 40;
const SMOOTH_FPS = 54;
const SMOOTH_WINDOWS_TO_RESTORE = 3;

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
  const smooth = useRef(0);

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
    if (fps < MIN_FPS) {
      noteGuardEvent(`${fps.toFixed(0)} fps on ${quality}: stepped down to ${lowerQuality(quality)}`);
      setQuality(lowerQuality(quality), true);
    }
    // Shed the optional overlays one step at a time before the whole quality tier has to drop, and bring them back slowly.
    const shed = getDetailShed();
    if (fps < SHED_FPS && shed < 2) {
      noteGuardEvent(`${fps.toFixed(0)} fps: overlays reduced to step ${shed + 1}`);
      setDetailShed((shed + 1) as 1 | 2);
      smooth.current = 0;
    } else if (fps >= SMOOTH_FPS && shed > 0) {
      smooth.current += 1;
      if (smooth.current >= SMOOTH_WINDOWS_TO_RESTORE) {
        setDetailShed((shed - 1) as 0 | 1);
        smooth.current = 0;
      }
    } else {
      smooth.current = 0;
    }
  });

  return null;
}
