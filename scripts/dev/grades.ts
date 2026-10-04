import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";
for (const key of Object.keys(REAL_CITY_DATA)) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  const t = new THREE.Vector3();
  let steep = 0, worst = 0, steepFt = 0, totalFt = 0;
  for (const e of net.edges) {
    let max = 0;
    for (let i = 0; i <= 40; i++) { e.spline.getTangentAt(i / 40, t); max = Math.max(max, Math.abs(t.y) / Math.hypot(t.x, t.z)); }
    totalFt += e.length;
    if (max > 0.04) { steep++; steepFt += e.length; }
    worst = Math.max(worst, max);
  }
  console.log(`${key.padEnd(12)} edges>4% grade ${steep}/${net.edges.length}  (${Math.round(100 * steepFt / totalFt)}% of road length)  steepest ${(worst * 100).toFixed(1)}%`);
}
