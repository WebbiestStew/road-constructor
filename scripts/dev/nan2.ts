import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
import { carriagewayOffsetAt, widthScaleAt } from "../../src/sim/laneGeometry";
import { buildGores } from "../../src/components/roadGeometry";
for (const key of ["chicago", "los-angeles"]) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  for (const e of net.edges) {
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    const n = Math.max(2, Math.ceil(e.length / 10));
    for (let i = 0; i <= n; i++) {
      const s = (e.length * i) / n, u = i / n;
      e.spline.getPointAt(u, p); e.spline.getTangentAt(u, t);
      const k = widthScaleAt(e, s), off = carriagewayOffsetAt(e, s, k);
      if (![p.x, p.y, p.z, t.x, t.z, k, off].every(Number.isFinite)) { console.log(key, e.id, "s", s.toFixed(1), "p", p.toArray(), "t", t.toArray(), "k", k, "off", off, "pad", !!e.padStart, !!e.padEnd, e.padEnd?.reach, e.padEnd?.gap.length); break; }
    }
    for (const g of buildGores(e)) { const pos = g.pave.getAttribute("position"); for (let i = 0; i < pos.count; i++) if (!Number.isFinite(pos.getX(i) + pos.getZ(i))) { console.log(key, e.id, "gore nan"); break; } }
  }
}
