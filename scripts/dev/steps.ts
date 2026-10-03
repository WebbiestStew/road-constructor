// Finds joints where one road continues into another of a different width (a visible pavement step).
import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
const keys = Object.keys(REAL_CITY_DATA);
for (const key of keys) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  let joints = 0, steps = 0, big = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const e of net.edges) {
    const outs = net.edges.filter((o) => o.fromNodeId === e.toNodeId && o.toNodeId !== e.fromNodeId);
    if (outs.length === 0) continue;
    e.spline.getTangentAt(1, a);
    let best: (typeof outs)[number] | null = null, bang = 99;
    for (const o of outs) {
      o.spline.getTangentAt(0, b);
      const ang = Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.z * b.z) / (Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z) || 1)))) * 180 / Math.PI;
      if (ang < bang) { bang = ang; best = o; }
    }
    if (!best || bang > 35) continue;
    joints++;
    const we = e.lanes * e.laneWidthFt, wo = best.lanes * best.laneWidthFt;
    if (Math.abs(we - wo) > 1) { steps++; if (Math.abs(we - wo) >= 20) big++; }
  }
  console.log(key.padEnd(12), "joints", String(joints).padStart(4), "width steps", String(steps).padStart(3), "(>=20ft:", big, ")");
}
