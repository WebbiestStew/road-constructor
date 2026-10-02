import * as THREE from "three";
import { assembleNetwork } from "../../src/sim/network";
import type { EdgeSpec, NodeSpec } from "../../src/sim/types";
const R = 56, n = 4;
const nodes: NodeSpec[] = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, position: [Math.cos((i * 2 * Math.PI) / n - Math.PI / 4) * R, 0, Math.sin((i * 2 * Math.PI) / n - Math.PI / 4) * R] }));
const edges: EdgeSpec[] = nodes.map((_, i) => {
  const a0 = (i * 2 * Math.PI) / n - Math.PI / 4, d = (2 * Math.PI) / n;
  const pts: [number, number, number][] = [];
  for (let k = 1; k < 4; k++) pts.push([Math.cos(a0 + (d * k) / 4) * R, 0, Math.sin(a0 + (d * k) / 4) * R]);
  return { id: `e${i}`, fromNodeId: `r${i}`, toNodeId: `r${(i + 1) % n}`, interiorPoints: pts, roadClassId: "lane", elevationLevelId: "ground", lanes: 2, laneWidthFt: 14, speedLimitMph: 20, isRoundaboutRing: true };
});
const net = assembleNetwork({ nodes, edges });
const a = new THREE.Vector3(), b = new THREE.Vector3();
for (let i = 0; i < n; i++) {
  net.edgesById.get(`e${i}`)!.spline.getTangentAt(1, a);
  net.edgesById.get(`e${(i + 1) % n}`)!.spline.getTangentAt(0, b);
  console.log(`joint ${i}: ${(a.angleTo(b) * 180 / Math.PI).toFixed(1)}°`);
}
