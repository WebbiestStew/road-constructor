import type { LOSGrade } from "@/sim/los";

/** How happy the city's drivers are right now, 0-100, from how congested the roads they're actually on are. */

const LOS_SCORE: Record<LOSGrade, number> = { A: 1, B: 0.88, C: 0.72, D: 0.5, E: 0.28, F: 0.08 };

export interface MoodInput {
  edgeTrafficStats: { vehicleCount: number; los: LOSGrade }[];
  problemEdgeCount: number;
  gridlockPenaltyTotal: number;
  activeCount: number;
}

export function computeMood(m: MoodInput): number {
  let weighted = 0;
  let total = 0;
  for (const s of m.edgeTrafficStats) {
    if (s.vehicleCount <= 0) continue;
    weighted += LOS_SCORE[s.los] * s.vehicleCount;
    total += s.vehicleCount;
  }
  if (total === 0) return 100;
  const base = (weighted / total) * 100;
  // Roads flagged as badly jammed, and cars forced out of gridlock, make people angrier than the averages alone say.
  const penalty = m.problemEdgeCount * 5 + Math.min(20, m.gridlockPenaltyTotal * 2);
  return Math.max(0, Math.min(100, Math.round(base - penalty)));
}

export function moodFace(mood: number): string {
  if (mood >= 85) return "😄";
  if (mood >= 70) return "🙂";
  if (mood >= 50) return "😐";
  if (mood >= 30) return "😠";
  return "🤬";
}

const LINES: { min: number; lines: string[] }[] = [
  { min: 85, lines: ["Smooth as butter out there. Don't touch anything!", "Citizens are sending thank-you cookies.", "The traffic report is boring today. Boring is good."] },
  { min: 70, lines: ["Not bad. A few grumpy drivers, but nothing I can't spin.", "People are mostly moving. Mostly.", "Good progress. Can you squeeze out a little more?"] },
  { min: 50, lines: ["My phone won't stop ringing about the traffic.", "The newspaper called it 'a bit of a crawl'.", "It's holding together, but nobody's happy."] },
  { min: 30, lines: ["My inbox is on fire. Please fix something!", "Drivers are honking at the speed limit signs now.", "A local radio host just called my city 'a parking lot'."] },
  { min: 0, lines: ["This is the worst traffic in history and I'm the mayor!", "People are abandoning cars. Do something. Anything!", "I'm seeing my own name on angry signs."] },
];

/** A line for the mayor; `salt` picks a different one over time without it flickering every render. */
export function mayorLine(mood: number, jammedRoads: number, salt: number): string {
  if (jammedRoads > 0 && mood < 70) {
    return jammedRoads === 1 ? "One road is completely jammed. Find the flashing marker!" : `${jammedRoads} roads are completely jammed. Look for the flashing markers!`;
  }
  const bucket = LINES.find((b) => mood >= b.min) ?? LINES[LINES.length - 1];
  return bucket.lines[Math.abs(salt) % bucket.lines.length];
}
