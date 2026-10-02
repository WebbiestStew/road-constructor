import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
const key = process.argv[2] ?? "san-antonio";
const data = REAL_CITY_DATA[key].network;
const net = assembleNetwork(data);
const p = { x: 0, y: 0, z: 0 } as any;
for (const e of net.edges) {
  let minY = 1e9, maxY = -1e9;
  for (let i = 0; i <= 40; i++) { const q = e.spline.getPointAt(i / 40); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  const spec = data.edges.find((s) => s.id === e.id)!;
  if (minY < -0.5 || spec.elevationLevelId === "tunnel" || spec.elevationLevelId === "cutting") {
    const a = data.nodes.find((n) => n.id === spec.fromNodeId)!, b = data.nodes.find((n) => n.id === spec.toNodeId)!;
    console.log(e.id.padEnd(24), spec.elevationLevelId.padEnd(8), `len ${e.length.toFixed(0)} y ${minY.toFixed(1)}..${maxY.toFixed(1)}  nodes ${a.position[1]}->${b.position[1]} lanes ${e.lanes}`);
  }
}
