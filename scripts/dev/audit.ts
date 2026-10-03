// Geometry audit of the real-city networks: numbers, not eyeballing.
//   npx tsx scripts/dev/audit.ts [city ...]
import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
import { carriagewayOffsetAt, widthScaleAt } from "../../src/sim/laneGeometry";
import { buildAsphaltRibbon, buildGores, computePierDescriptors, indexPierConflicts } from "../../src/components/roadGeometry";
import type { Edge3D } from "../../src/sim/types";

const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(REAL_CITY_DATA);
const deg = (r: number) => (r * 180) / Math.PI;

interface Sample { x: number; z: number; y: number; half: number; s: number; tx: number; tz: number; off: number; k: number }
function sampleEdge(e: Edge3D, step = 10): Sample[] {
  const out: Sample[] = [];
  const p = new THREE.Vector3(), t = new THREE.Vector3();
  const n = Math.max(2, Math.ceil(e.length / step));
  for (let i = 0; i <= n; i++) {
    const s = (e.length * i) / n, u = i / n;
    e.spline.getPointAt(u, p); e.spline.getTangentAt(u, t);
    const l = Math.hypot(t.x, t.z) || 1, rx = -t.z / l, rz = t.x / l;
    const k = widthScaleAt(e, s), off = carriagewayOffsetAt(e, s, k);
    out.push({ x: p.x + rx * off, z: p.z + rz * off, y: p.y, half: ((e.lanes * e.laneWidthFt) / 2 + 4) * k, s, tx: t.x / l, tz: t.z / l, off, k });
  }
  return out;
}

let totalProblems = 0;
for (const key of keys) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  indexPierConflicts(net.edges);
  const problems: Record<string, string[]> = {};
  const add = (kind: string, msg: string) => ((problems[kind] ??= []).push(msg));
  const samples = new Map(net.edges.map((e) => [e, sampleEdge(e)]));
  const inBy = new Map<string, Edge3D[]>(), outBy = new Map<string, Edge3D[]>();
  for (const e of net.edges) {
    (inBy.get(e.toNodeId) ?? inBy.set(e.toNodeId, []).get(e.toNodeId)!).push(e);
    (outBy.get(e.fromNodeId) ?? outBy.set(e.fromNodeId, []).get(e.fromNodeId)!).push(e);
  }
  const id = (e: Edge3D) => e.id.slice(0, 16);

  for (const e of net.edges) {
    const S = samples.get(e)!;
    const halfRoad = (e.lanes * e.laneWidthFt) / 2;
    // A. NaN / degenerate
    if (S.some((q) => !Number.isFinite(q.x + q.y + q.z))) add("nan", id(e));
    const rib = buildAsphaltRibbon(e, 4, 0).getAttribute("position");
    let bad = 0;
    for (let i = 0; i < rib.count; i++) if (!Number.isFinite(rib.getX(i) + rib.getY(i) + rib.getZ(i))) bad++;
    if (bad) add("nan", `${id(e)} ribbon`);
    // B. grade
    let maxGrade = 0;
    for (let i = 1; i < S.length; i++) maxGrade = Math.max(maxGrade, Math.abs(S[i].y - S[i - 1].y) / Math.max(1, S[i].s - S[i - 1].s));
    if (maxGrade > 0.08) add("grade>8%", `${(maxGrade * 100).toFixed(1)}% ${id(e)} len=${e.length.toFixed(0)} rise=${(S[S.length - 1].y - S[0].y).toFixed(1)}ft`);
    // C. curvature: turning radius vs half width (the inside edge folds over when radius < half width)
    for (let i = 1; i < S.length - 1; i++) {
      const a = Math.atan2(S[i].tz, S[i].tx), b = Math.atan2(S[i + 1].tz, S[i + 1].tx);
      let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
      const ds = Math.max(1, S[i + 1].s - S[i].s);
      const radius = ds / Math.max(1e-6, d);
      if (radius < S[i].half * S[i].k + 1 && S[i].k > 0.5) { add("fold (radius<halfwidth)", `${id(e)} at ${S[i].x.toFixed(0)},${S[i].z.toFixed(0)} r=${radius.toFixed(0)}ft half=${S[i].half.toFixed(0)} turn=${deg(d).toFixed(0)}deg over ${ds.toFixed(0)}ft s=${S[i].s.toFixed(0)}/${e.length.toFixed(0)} lanes=${e.lanes}`); break; }
    }
    // D/E. lateral offset and width-scale continuity
    for (let i = 1; i < S.length; i++) {
      const ds = S[i].s - S[i - 1].s;
      if (Math.abs(S[i].off - S[i - 1].off) > Math.max(3, ds * 0.5)) { add("offset jump", `${id(e)} ${Math.abs(S[i].off - S[i - 1].off).toFixed(1)}ft at s=${S[i].s.toFixed(0)}/${e.length.toFixed(0)} shift=${e.lateralShiftFt} pad=${!!e.padStart}${!!e.padEnd} taper=${e.taperStartFt}/${e.taperEndFt} lanes=${e.lanes}`); break; }
    }
    for (let i = 1; i < S.length; i++) {
      if (Math.abs(S[i].k - S[i - 1].k) * (halfRoad + 4) > 4) { add("width jump", `${id(e)} s=${S[i].s.toFixed(0)}`); break; }
    }
    // F. sinks below ground (non-sunken)
    if (!e.sunken && S.some((q) => q.y < -0.6)) add("below ground", `${id(e)} min y ${Math.min(...S.map((q) => q.y)).toFixed(1)}`);
    // J. dead ends
    const outs = outBy.get(e.toNodeId)?.filter((o) => o.toNodeId !== e.fromNodeId).length ?? 0;
    if (outs === 0 && !e.zone && !net.edges.some((o) => o !== e && o.fromNodeId === e.toNodeId)) {
      const endZone = net.edges.some((o) => o.toNodeId === e.toNodeId && o.zone);
      if (!endZone) add("dead end (no exit road, no zone)", `${id(e)} at ${S[S.length - 1].x.toFixed(0)},${S[S.length - 1].z.toFixed(0)}`);
    }
    // K. gores sane
    for (const g of buildGores(e)) {
      const pos = g.pave.getAttribute("position");
      for (let i = 0; i < pos.count; i++) if (!Number.isFinite(pos.getX(i) + pos.getZ(i))) { add("nan", `${id(e)} gore`); break; }
    }
    // I. pier columns standing in another road's lanes
    for (const pier of computePierDescriptors(e)) {
      for (const off of pier.columnOffsets) {
        const cx = pier.capPosition[0] + Math.sin(pier.rotationY) * off, cz = pier.capPosition[2] + Math.cos(pier.rotationY) * off;
        const top = pier.capPosition[1];
        let hit = "";
        for (const [o, OS] of samples) {
          if (o === e) continue;
          for (const q of OS) {
            if (q.y > top - 3 || q.y < -1) continue; // a road passing above the cap or underground doesn't matter
            if (Math.hypot(q.x - cx, q.z - cz) < q.half - 1) { hit = id(o); break; }
          }
          if (hit) break;
        }
        if (hit) { add("pier column in lanes of another road", `${id(e)} d=${pier.distanceFt.toFixed(0)} capY=${top.toFixed(1)} at ${cx.toFixed(0)},${cz.toFixed(0)} in ${hit}`); break; }
      }
    }
  }

  // G. joints: continuity of pavement, heading, height, slope
  const ta = new THREE.Vector3(), tb = new THREE.Vector3();
  for (const e of net.edges) {
    const A = samples.get(e)!;
    for (const o of outBy.get(e.toNodeId) ?? []) {
      if (o.toNodeId === e.fromNodeId) continue;
      const B = samples.get(o)!;
      e.spline.getTangentAt(1, ta); o.spline.getTangentAt(0, tb);
      const ang = deg(Math.acos(Math.max(-1, Math.min(1, (ta.x * tb.x + ta.z * tb.z) / ((Math.hypot(ta.x, ta.z) || 1) * (Math.hypot(tb.x, tb.z) || 1))))));
      if (ang > 50) continue; // a real turn
      const a = A[A.length - 1], b = B[0];
      const tip = a.half * 0.5 < 1.5 || b.half * 0.5 < 1.5; // tapered to a point
      const slopeA = Math.atan2(ta.y, Math.hypot(ta.x, ta.z)), slopeB = Math.atan2(tb.y, Math.hypot(tb.x, tb.z));
      if (Math.abs(a.y - b.y) > 0.4) add("joint height step", `${id(e)}->${id(o)} ${Math.abs(a.y - b.y).toFixed(1)}ft`);
      if (deg(Math.abs(slopeA - slopeB)) > 3) add("joint slope jump", `${id(e)}->${id(o)} ${deg(Math.abs(slopeA - slopeB)).toFixed(1)}deg`);
      if (!tip) {
        if (ang > 6 && ang <= 35) add("joint heading mismatch", `${id(e)}->${id(o)} ${ang.toFixed(0)}deg at ${a.x.toFixed(0)},${a.z.toFixed(0)}`);
        const rx = -a.tz, rz = a.tx;
        const dl = Math.hypot((a.x - rx * a.half) - (b.x - -b.tz * b.half), (a.z - rz * a.half) - (b.z - b.tx * b.half));
        const dr = Math.hypot((a.x + rx * a.half) - (b.x + -b.tz * b.half), (a.z + rz * a.half) - (b.z + b.tx * b.half));
        if (Math.max(dl, dr) > 3 && ang <= 35) add("joint edge offset", `${id(e)}->${id(o)} L${dl.toFixed(1)} R${dr.toFixed(1)}ft at ${a.x.toFixed(0)},${a.z.toFixed(0)}`);
      }
    }
  }

  // H. roads lying on roads: sustained overlap of pavements at the same height between roads that do not join there
  const edges = net.edges;
  const grid = new Map<string, { e: Edge3D; q: Sample }[]>();
  const cell = 60;
  for (const e of edges) for (const q of samples.get(e)!) {
    const k = `${Math.floor(q.x / cell)},${Math.floor(q.z / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push({ e, q });
  }
  const overlap = new Map<string, { len: number; at: string; maxDepth: number }>();
  const nodeOf = (e: Edge3D) => [e.fromNodeId, e.toNodeId];
  for (const e of edges) {
    for (const q of samples.get(e)!) {
      const cx = Math.floor(q.x / cell), cz = Math.floor(q.z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const { e: o, q: r } of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (o === e || id(o) <= id(e)) continue;
        if (o.fromNodeId === e.toNodeId && o.toNodeId === e.fromNodeId) continue; // opposite carriageway
        if (Math.abs(q.y - r.y) > 4) continue;
        // near a node the two share, overlap is the junction itself
        const shared = nodeOf(e).filter((n) => nodeOf(o).includes(n));
        if (shared.length) {
          const reachOf = (x: Edge3D, sm: Sample) => Math.max(200, (sm.s < x.length / 2 ? x.padStart?.reach : x.padEnd?.reach) ?? 0) + 60;
          if (Math.min(q.s, e.length - q.s) < reachOf(e, q) || Math.min(r.s, o.length - r.s) < reachOf(o, r)) continue;
        }
        if (q.half < 3 || r.half < 3) continue;
        const d = Math.hypot(q.x - r.x, q.z - r.z);
        const depth = q.half * 0.6 + r.half * 0.6 - d; // overlap of the lane areas (excluding shoulders)
        if (depth > 1.5) {
          const kk = `${id(e)}|${id(o)}`;
          const cur = overlap.get(kk) ?? { len: 0, at: `${q.x.toFixed(0)},${q.z.toFixed(0)}`, maxDepth: 0 };
          cur.len += 10; cur.maxDepth = Math.max(cur.maxDepth, depth);
          overlap.set(kk, cur);
        }
      }
    }
  }
  for (const [kk, v] of overlap) if (v.len >= 60) add("roads overlapping", `${kk} ${v.len}ft deep ${v.maxDepth.toFixed(0)}ft at ${v.at}`);

  const n = Object.values(problems).reduce((s, a) => s + a.length, 0);
  totalProblems += n;
  console.log(`\n=== ${key}: ${net.edges.length} roads, ${n} findings`);
  for (const [kind, list] of Object.entries(problems)) {
    console.log(`  ${kind}: ${list.length}`);
    for (const m of list.slice(0, Number(process.env.SHOW ?? 4))) console.log(`     ${m}`);
  }
}
console.log(`\nTOTAL findings: ${totalProblems}`);
