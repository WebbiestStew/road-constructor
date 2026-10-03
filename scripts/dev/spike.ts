import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
const [key, prefix] = [process.argv[2], process.argv[3]];
const spec = REAL_CITY_DATA[key].network;
const net = assembleNetwork(spec);
for (const e of net.edges.filter((x) => x.id.startsWith(prefix))) {
  const raw = spec.edges.find((x) => x.id === e.id)!;
  const from = spec.nodes.find((n) => n.id === raw.fromNodeId)!.position, to = spec.nodes.find((n) => n.id === raw.toNodeId)!.position;
  console.log(e.id, "len", e.length.toFixed(0), "interior pts", raw.interiorPoints.length);
  console.log("  from", from.map((v) => v.toFixed(0)).join(","), "interior", raw.interiorPoints.slice(0, 3).map((p) => p.map((v) => v.toFixed(0)).join(",")).join(" | "), "... to", to.map((v) => v.toFixed(0)).join(","));
  const t = new THREE.Vector3(), p = new THREE.Vector3();
  for (const s of [0, 3, 6, 10, 15, 20, 30]) { const u = s / e.length; e.spline.getPointAt(u, p); e.spline.getTangentAt(u, t); console.log(`  s=${s} p=(${p.x.toFixed(1)},${p.z.toFixed(1)}) tan=(${t.x.toFixed(2)},${t.z.toFixed(2)})`); }
}
