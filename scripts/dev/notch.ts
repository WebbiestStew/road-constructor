// Joints where the pavement edges of a road and the one it continues into don't meet (a notch or flat-cut end).
import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
import { carriagewayOffsetAt, widthScaleAt } from "../../src/sim/laneGeometry";
const key = process.argv[2] ?? "chicago";
const net = assembleNetwork(REAL_CITY_DATA[key].network);
const edges = (e: (typeof net.edges)[number], atEnd: boolean) => {
  const s = atEnd ? e.length : 0, u = atEnd ? 1 : 0;
  const k = widthScaleAt(e, s), off = carriagewayOffsetAt(e, s, k);
  const p = e.spline.getPointAt(u), t = e.spline.getTangentAt(u);
  const l = Math.hypot(t.x, t.z) || 1, rx = -t.z / l, rz = t.x / l;
  const half = (e.lanes * e.laneWidthFt * k) / 2;
  const c = { x: p.x + rx * off, z: p.z + rz * off };
  return { L: { x: c.x - rx * half, z: c.z - rz * half }, R: { x: c.x + rx * half, z: c.z + rz * half }, half, k };
};
const ta = new THREE.Vector3(), tb = new THREE.Vector3();
for (const e of net.edges) {
  const nexts = net.edges.filter((n) => n.fromNodeId === e.toNodeId && n.toNodeId !== e.fromNodeId);
  for (const o of nexts) {
    e.spline.getTangentAt(1, ta); o.spline.getTangentAt(0, tb);
    const ang = (Math.acos(Math.max(-1, Math.min(1, ta.clone().setY(0).normalize().dot(tb.clone().setY(0).normalize())))) * 180) / Math.PI;
    if (ang > 50) continue;
    const A = edges(e, true), B = edges(o, false);
    if (A.half < 2 || B.half < 2) continue; // tips are fine
    const dl = Math.hypot(A.L.x - B.L.x, A.L.z - B.L.z), dr = Math.hypot(A.R.x - B.R.x, A.R.z - B.R.z);
    // either orientation: edges pair up left-left/right-right
    if (Math.max(dl, dr) > 3 || ang > 4) console.log(e.id.slice(0, 18), "->", o.id.slice(0, 18), "dL", dl.toFixed(1), "dR", dr.toFixed(1), "halves", A.half.toFixed(0), B.half.toFixed(0), "ang", ang.toFixed(0), "lanes", e.lanes, o.lanes, "at", A.L.x.toFixed(0), A.L.z.toFixed(0), "flags", e.taperEndFt > 0, o.taperStartFt > 0, !!e.padEnd, !!o.padStart);
  }
}
