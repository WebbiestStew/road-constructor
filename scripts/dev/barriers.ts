// Lists short barrier runs (likely stray slabs) in a real city.
import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";
import { indexPierConflicts, visibleRanges } from "../../src/components/roadGeometry";
const key = process.argv[2] ?? "chicago";
const net = assembleNetwork(REAL_CITY_DATA[key].network);
indexPierConflicts(net.edges);
const p = new THREE.Vector3();
for (const e of net.edges) {
  if (e.sunken || !e.isFreeway) continue;
  const half = (e.lanes * e.laneWidthFt) / 2 + 3.5;
  const t0 = e.length > 135 ? (e.startsAtJunction ? 45 / e.length : 0) : 0;
  const t1 = e.length > 135 ? (e.endsAtJunction ? 1 - 45 / e.length : 1) : 1;
  for (const off of [-half, half]) {
    for (const [a0, b0] of visibleRanges(e, off)) {
      const a = Math.max(a0, t0), b = Math.min(b0, t1);
      const len = (b - a) * e.length;
      if (len > 12 && len < 70) {
        e.spline.getPointAt((a + b) / 2, p);
        console.log(e.id, "off", off.toFixed(0), "len", len.toFixed(0), "len edge", e.length.toFixed(0), "at", p.x.toFixed(0), p.z.toFixed(0), "y", p.y.toFixed(0), "pad", !!e.padStart, !!e.padEnd);
      }
    }
  }
}
