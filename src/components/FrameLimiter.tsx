"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";

/** How long after the last mouse/keyboard input the scene keeps rendering at full rate (covers camera damping settling). */
const INPUT_GRACE_MS = 1600;
/** Frame rate while nothing is moving and nobody is touching anything. */
const IDLE_FPS = 8;

/**
 * Drives the Canvas's frame loop itself (the Canvas must use frameloop="never"). Two savings that matter on a
 * laptop that's running hot:
 *  - a frame-rate ceiling, so a 120/144 Hz display doesn't mean 120/144 renders a second, and
 *  - dropping to a trickle when traffic is paused and the player isn't interacting, since nothing on screen is
 *    changing and re-drawing an identical frame is pure heat.
 * Renders nothing itself.
 */
export default function FrameLimiter({ maxFps, active }: { maxFps: number; active: boolean }) {
  const advance = useThree((s) => s.advance);

  useEffect(() => {
    let raf = 0;
    let lastRender = 0;
    let lastInput = performance.now();
    const bump = () => {
      lastInput = performance.now();
    };
    const events = ["pointermove", "pointerdown", "wheel", "keydown", "keyup", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const awake = active || t - lastInput < INPUT_GRACE_MS;
      const interval = 1000 / (awake ? maxFps : IDLE_FPS);
      if (t - lastRender < interval - 2) return;
      lastRender = t;
      advance(t / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [advance, maxFps, active]);

  return null;
}
