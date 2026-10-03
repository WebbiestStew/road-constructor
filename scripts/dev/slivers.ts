// Finds ramps that run alongside another road with a thin strip of grass between the two pavements.
import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
import { carriagewayOffsetAt, widthScaleAt } from "../../src/sim/laneGeometry";
const key = process.argv[2] ?? "chicago";
const net = assembleNetwork(REAL_CITY_DATA[key].network);
const pts = (e: (typeof net.edges)[number]) => {
  const out: { x: number; z: number; y: number; half: number; tx: number; tz: number; s: number }[] = [];
  const p = new THREE.Vector3(), t = new THREE.Vector3();
  for (let s = 0; s <= e.length; s += 10) {
    const u = Math.min(1, s / e.length);
    e.spline.getPointAt(u, p); e.spline.getTangentAt(u, t);
    const k = widthScaleAt(e, s);
    const off = carriagewayOffsetAt(e, s, k);
    const rx = t.z, rz = -t.x; const l = Math.hypot(rx, rz) || 1;
    out.push({ x: p.x + (rx / l) * off, z: p.z + (rz / l) * off, y: p.y, half: ((e.lanes * e.laneWidthFt) / 2 + 2) * k, tx: t.x, tz: t.z, s });
  }
  return out;
};
const cache = new Map(net.edges.map((e) => [e, pts(e)]));
for (const e of net.edges) {
  if (e.length < 150) continue;
  const mine = cache.get(e)!;
  let run = 0, runStart = 0, worst = 0;
  const report = (end: number) => { if (run >= 100) console.log(e.id, "sliver", run.toFixed(0), "ft from", runStart.toFixed(0), "to", end.toFixed(0), "of", e.length.toFixed(0), "pad", !!e.padStart, !!e.padEnd, "at", mine[Math.round(runStart / 10)].x.toFixed(0), mine[Math.round(runStart / 10)].z.toFixed(0)); };
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    let found = false;
    for (const o of net.edges) {
      if (o === e) continue;
      if (o.fromNodeId === e.toNodeId && o.toNodeId === e.fromNodeId) continue;
      for (const b of cache.get(o)!) {
        if (Math.abs(a.y - b.y) > 3.5) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        const gap = d - a.half - b.half;
        if (gap > 0.5 && gap < 40 && a.half > 3) {
          const dot = (a.tx * b.tx + a.tz * b.tz) / (Math.hypot(a.tx, a.tz) * Math.hypot(b.tx, b.tz));
          if (Math.abs(dot) > 0.94) { found = true; break; }
        }
      }
      if (found) break;
    }
    if (found) { if (run === 0) runStart = a.s; run += 10; worst = a.s; }
    else { report(worst); run = 0; }
  }
  report(worst);
}
