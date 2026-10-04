// Finds joints where one road continues into another with a sharp bend or a slope jump.
import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";

const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(REAL_CITY_DATA);
for (const key of keys) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  const incoming = new Map<string, typeof net.edges>();
  for (const e of net.edges) {
    const arr = incoming.get(e.toNodeId) ?? [];
    arr.push(e);
    incoming.set(e.toNodeId, arr);
  }
  let joints = 0, bendOver12 = 0, bendOver25 = 0, slopeJump = 0, heightStep = 0, worst = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
  for (const e of net.edges) {
    // continuation: the single outgoing edge whose heading is straightest from this edge's end
    const nexts = net.edges.filter((n) => n.fromNodeId === e.toNodeId && !(n.toNodeId === e.fromNodeId));
    if (nexts.length === 0) continue;
    e.spline.getTangentAt(1, a);
    let best: { n: (typeof nexts)[number]; ang: number } | null = null;
    for (const n of nexts) {
      n.spline.getTangentAt(0, b);
      const ang = (Math.acos(Math.max(-1, Math.min(1, new THREE.Vector3(a.x, 0, a.z).normalize().dot(new THREE.Vector3(b.x, 0, b.z).normalize())))) * 180) / Math.PI;
      if (!best || ang < best.ang) best = { n, ang };
    }
    if (!best) continue;
    joints++;
    if (best.ang > 12) bendOver12++;
    if (best.ang > 25) bendOver25++;
    worst = Math.max(worst, best.ang);
    e.spline.getPointAt(1, p);
    best.n.spline.getPointAt(0, q);
    if (Math.abs(p.y - q.y) > 0.5) heightStep++;
    const sa = Math.asin(a.y) , sb = Math.asin((() => { best!.n.spline.getTangentAt(0, b); return b.y; })());
    if (Math.abs(sa - sb) > 0.05) slopeJump++;
  }
  console.log(`${key.padEnd(12)} joints ${joints}  bend>12° ${bendOver12}  bend>25° ${bendOver25}  worst ${worst.toFixed(0)}°  slopeJump ${slopeJump}  heightStep ${heightStep}`);
}
