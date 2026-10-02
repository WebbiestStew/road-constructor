"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { playSuccessChime } from "@/lib/sound";
import { getPrefs } from "@/lib/prefs";

interface Piece {
  id: number;
  left: number;
  color: string;
  delay: number;
  drift: number;
  spin: number;
}

const COLORS = ["#ff5fa8", "#7c3aed", "#38bdf8", "#22c55e", "#f59e0b", "#fb7185"];

let pieceSeq = 0;

/** Bursts a little confetti whenever a destination's contract newly meets its speed threshold — a small reward for actually fixing the traffic. */
export default function Confetti({ sim }: { sim: UseTrafficSimulationReturn }) {
  const metContractsRef = useRef<Set<string>>(new Set());
  const [pieces, setPieces] = useState<Piece[]>([]);

  useEffect(() => {
    const newlyMet: string[] = [];
    for (const c of sim.metrics.contracts) {
      if (c.meetsThreshold && !metContractsRef.current.has(c.edgeId)) {
        newlyMet.push(c.edgeId);
      } else if (!c.meetsThreshold) {
        metContractsRef.current.delete(c.edgeId);
      }
    }
    if (newlyMet.length === 0) return;
    for (const id of newlyMet) metContractsRef.current.add(id);

    // Reduced motion: keep the chime, skip the falling pieces.
    const burst: Piece[] = Array.from({ length: getPrefs().reducedMotion ? 0 : 26 }, () => ({
      id: pieceSeq++,
      left: 30 + Math.random() * 40,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      delay: Math.random() * 150,
      drift: (Math.random() - 0.5) * 160,
      spin: 360 + Math.random() * 360,
    }));

    // Deferred to a rAF callback (rather than called directly in the effect
    // body) so this reads as "schedule a burst" — the correct shape for
    // reacting to an external system's change, per React's effect guidance.
    const raf = requestAnimationFrame(() => {
      setPieces((prev) => [...prev, ...burst]);
      playSuccessChime();
    });

    const timer = setTimeout(() => {
      setPieces((prev) => prev.filter((p) => !burst.some((b) => b.id === p.id)));
    }, 1200);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [sim.metrics.contracts]);

  if (pieces.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-16 z-30 h-0">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti-piece"
          style={
            {
              left: `${p.left}%`,
              background: p.color,
              animationDelay: `${p.delay}ms`,
              "--drift": `${p.drift}px`,
              "--spin": `${p.spin}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
