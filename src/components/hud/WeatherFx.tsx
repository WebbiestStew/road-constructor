"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useQuality } from "@/lib/quality";

const TARGET_FPS = 24;

/**
 * Weather as a screen overlay: a cool tint plus falling rain streaks, or a pale haze for fog. It is a flat 2D
 * canvas on top of the scene, so it costs nothing in the 3D render and looks the same at any zoom. Renders nothing
 * in clear weather, and holds still (tint only) if the player asked their system for reduced motion.
 */
export default function WeatherFx({ sim }: { sim: UseTrafficSimulationReturn }) {
  const weather = sim.metrics.weather;
  const quality = useQuality();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (weather !== "rain") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const count = quality === "high" ? 260 : quality === "medium" ? 170 : 100;
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    const drops = Array.from({ length: count }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      len: 12 + Math.random() * 16,
      speed: 800 + Math.random() * 700,
    }));

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = (now - last) / 1000;
      if (dt < 1 / TARGET_FPS) return;
      last = now;
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.strokeStyle = "rgba(205, 225, 245, 0.45)";
      ctx2d.lineWidth = 1.2;
      ctx2d.beginPath();
      for (const d of drops) {
        d.y += d.speed * dt;
        d.x -= d.speed * dt * 0.18;
        if (d.y > h) {
          d.y = -d.len;
          d.x = Math.random() * (w + 200);
        }
        ctx2d.moveTo(d.x, d.y);
        ctx2d.lineTo(d.x + d.len * 0.18, d.y - d.len);
      }
      ctx2d.stroke();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [weather, quality]);

  if (weather === "clear") return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      style={{ background: weather === "rain" ? "rgba(52, 70, 96, 0.28)" : "rgba(235, 240, 245, 0.42)" }}
    >
      {weather === "rain" && <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />}
    </div>
  );
}
