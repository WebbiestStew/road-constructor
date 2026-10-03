// Finds joints where a road continues into another but their pavements don't line up (offset or width jump).
import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
import { carriagewayOffsetAt, widthScaleAt } from "../../src/sim/laneGeometry";
const key = process.argv[2] ?? "chicago";
const net = assembleNetwork(REAL_CITY_DATA[key].network);
const a = new THREE.Vector3(), b = new THREE.Vector3(), ta = new THREE.Vector3(), tb = new THREE.Vector3();
const side = (e: (typeof net.edges)[number], atEnd: boolean) => {
  const s = atEnd ? e.length : 0;
  const k = widthScaleAt(e, s);
  const off = carriagewayOffsetAt(e, s, k);
  const u = atEnd ? 1 : 0;
  const p = e.spline.getPointAt(u), t = e.spline.getTangentAt(u);
  const rx = t.z, rz = -t.x; const l = Math.hypot(rx, rz) || 1;
  const half = (e.lanes * e.laneWidthFt * k) / 2;
  return { x: p.x + (rx / l) * off, z: p.z + (rz / l) * off, half, left: off - half, right: off + half };
};
for (const e of net.edges) {
  const nexts = net.edges.filter((n) => n.fromNodeId === e.toNodeId && n.toNodeId !== e.fromNodeId);
  if (!nexts.length) continue;
  e.spline.getTangentAt(1, ta);
  let best = nexts[0], bang = 9;
  for (const n of nexts) { n.spline.getTangentAt(0, tb); const ang = Math.acos(Math.max(-1, Math.min(1, ta.clone().setY(0).normalize().dot(tb.clone().setY(0).normalize())))); if (ang < bang) { bang = ang; best = n; } }
  const A = side(e, true), B = side(best, false);
  const dx = Math.hypot(A.x - B.x, A.z - B.z), dw = Math.abs(A.half - B.half);
  if (dx > 3 || dw > 4) if (A.half > 1 && B.half > 1) console.log("taperE", e.taperEndFt.toFixed(0), "endScale", e.endScale, "o.taperStart", best.taperStartFt.toFixed(0), "o.startScale", best.startScale, "nexts", nexts.length, "ang", (bang*180/Math.PI).toFixed(0), "|", e.id.slice(0, 20), "->", best.id.slice(0, 20), "centre jump", dx.toFixed(1), "half-width jump", dw.toFixed(1), "(", A.half.toFixed(0), "->", B.half.toFixed(0), ") lanes", e.lanes, best.lanes, "at", A.x.toFixed(0), A.z.toFixed(0));
}
