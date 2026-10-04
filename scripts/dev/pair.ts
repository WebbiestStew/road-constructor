import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";
const [key, a, b] = process.argv.slice(2);
const net = assembleNetwork(REAL_CITY_DATA[key].network);
for (const e of net.edges.filter((x) => x.id.startsWith(a) || x.id.startsWith(b))) {
  const p0 = e.spline.getPointAt(0), p1 = e.spline.getPointAt(1), pm = e.spline.getPointAt(0.5);
  console.log(e.id, e.roadClassId, "lanes", e.lanes, "len", e.length.toFixed(0), "y", p0.y.toFixed(1), pm.y.toFixed(1), p1.y.toFixed(1), "from", p0.x.toFixed(0), p0.z.toFixed(0), "to", p1.x.toFixed(0), p1.z.toFixed(0), "shift", e.lateralShiftFt, "oneway-pair", net.edges.some((o) => o.fromNodeId === e.toNodeId && o.toNodeId === e.fromNodeId), "elev", e.elevationLevelId);
}
