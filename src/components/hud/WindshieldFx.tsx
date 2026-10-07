"use client";

import { useEffect, useRef } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { useGraphics } from "@/lib/quality";
import { useReducedMotion } from "@/lib/prefs";

const TARGET_FPS = 30;
const WIPER_PERIOD_S = 3.4;

/**
 * Rain on the glass, for the driver's-seat view: beads gather on the windscreen, a wiper sweeps them away every few
 * seconds, and a dark band along the bottom stands in for the dashboard. A flat canvas over the 3D view, so it costs
 * nothing in the scene. Only while driving in the rain from the driver's seat; holds still if the player asked for
 * reduced motion or switched the rain effect off.
 */
export default function WindshieldFx({ sim }: { sim: UseTrafficSimulationReturn }) {
  const hood = useEditorStore((s) => s.drivingId !== null && s.driveCam === "hood");
  const raining = sim.metrics.weather === "rain";
  const graphics = useGraphics();
  const reduced = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const show = hood && raining && graphics.weatherEffects;

  useEffect(() => {
    if (!show || reduced) return;
    const canvas = canvasRef.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    const beads: { x: number; y: number; r: number; born: number; slide: number }[] = [];
    let raf = 0;
    let last = performance.now();
    const t0 = last;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = (now - last) / 1000;
      if (dt < 1 / TARGET_FPS) return;
      last = now;
      const t = (now - t0) / 1000;
      // The wiper is a line pivoting at the bottom centre, sweeping out and back; beads it passes over are wiped.
      const phase = (t % WIPER_PERIOD_S) / WIPER_PERIOD_S;
      const sweep = phase < 0.5 ? phase * 2 : 2 - phase * 2;
      const angle = -Math.PI * 0.12 - sweep * Math.PI * 0.76;
      const px = w * 0.5;
      const py = h * 1.02;
      const reach = Math.hypot(w, h) * 0.9;
      const wiperAngle = angle;
      for (let i = 0; i < 3; i++) beads.push({ x: Math.random() * w, y: Math.random() * h * 0.85, r: 1.5 + Math.random() * 3.6, born: t, slide: Math.random() < 0.18 ? 14 + Math.random() * 30 : 0 });
      if (beads.length > 520) beads.splice(0, beads.length - 520);
      g.clearRect(0, 0, w, h);
      for (let i = beads.length - 1; i >= 0; i--) {
        const b = beads[i];
        // wiped: within a few pixels of the arm's line, on the side it has already swept
        const dx = b.x - px;
        const dy = b.y - py;
        const a = Math.atan2(dy, dx);
        const dist = Math.hypot(dx, dy);
        if (dist < reach && ((phase < 0.5 && a > wiperAngle - 0.05 && a < -Math.PI * 0.12) || (phase >= 0.5 && a < wiperAngle + 0.05 && a > -Math.PI * 0.88))) {
          beads.splice(i, 1);
          continue;
        }
        if (b.slide > 0) b.y += b.slide * dt;
        const age = Math.min(1, (t - b.born) / 0.6);
        g.fillStyle = `rgba(215, 232, 246, ${0.35 * age})`;
        g.beginPath();
        g.ellipse(b.x, b.y, b.r, b.r * (b.slide > 0 ? 1.7 : 1.1), 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = `rgba(255, 255, 255, ${0.5 * age})`;
        g.fillRect(b.x - b.r * 0.3, b.y - b.r * 0.5, b.r * 0.5, b.r * 0.5);
      }
      // the wiper arm
      g.strokeStyle = "rgba(15, 17, 22, 0.88)";
      g.lineWidth = 5;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.cos(wiperAngle) * reach, py + Math.sin(wiperAngle) * reach);
      g.stroke();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [show, reduced]);

  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[6]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-x-0 bottom-0 h-[11%] bg-gradient-to-t from-black/85 via-black/60 to-transparent" />
    </div>
  );
}
