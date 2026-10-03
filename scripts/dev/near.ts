// Edge ends that sit within a short distance of another edge's start at a different node (a visual joint with no graph link).
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
const key = process.argv[2] ?? "chicago";
const net = assembleNetwork(REAL_CITY_DATA[key].network);
for (const e of net.edges) {
  const a = e.spline.getPointAt(1);
  for (const o of net.edges) {
    if (o === e || o.fromNodeId === e.toNodeId) continue;
    const b = o.spline.getPointAt(0);
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 40 && Math.abs(a.y - b.y) < 4) console.log(e.id.slice(0, 18), "->", o.id.slice(0, 18), "gap", d.toFixed(1), "lanes", e.lanes, o.lanes, "at", a.x.toFixed(0), a.z.toFixed(0));
  }
}
