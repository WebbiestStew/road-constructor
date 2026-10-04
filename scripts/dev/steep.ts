import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";
const key = process.argv[2] ?? "san-antonio";
const data = REAL_CITY_DATA[key].network;
const net = assembleNetwork(data);
const t = new THREE.Vector3();
const rows: { id: string; max: number; at: number; len: number; y0: number; y1: number; pts: number }[] = [];
for (const e of net.edges) {
  let max = 0, at = 0;
  for (let i = 0; i <= 80; i++) { e.spline.getTangentAt(i / 80, t); const g = Math.abs(t.y) / Math.hypot(t.x, t.z); if (g > max) { max = g; at = i / 80; } }
  const spec = data.edges.find((s) => s.id === e.id)!;
  const a = data.nodes.find((n) => n.id === spec.fromNodeId)!, b = data.nodes.find((n) => n.id === spec.toNodeId)!;
  rows.push({ id: e.id, max, at, len: e.length, y0: a.position[1], y1: b.position[1], pts: spec.interiorPoints.length });
}
rows.sort((x, y) => y.max - x.max);
for (const r of rows.slice(0, 8)) console.log(r.id.padEnd(22), `grade ${(r.max * 100).toFixed(1)}% at t=${r.at.toFixed(2)} len ${r.len.toFixed(0)} y ${r.y0}->${r.y1} interior ${r.pts}`);
