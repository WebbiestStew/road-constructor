import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
import { carriagewayOffsetAt, widthScaleAt } from "../../src/sim/laneGeometry";
import { buildAsphaltRibbon } from "../../src/components/roadGeometry";
for (const key of Object.keys(REAL_CITY_DATA)) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  for (const e of net.edges) {
    const rib = buildAsphaltRibbon(e, 4, 0).getAttribute("position");
    let bad = -1;
    for (let i = 0; i < rib.count; i++) if (!Number.isFinite(rib.getX(i) + rib.getY(i) + rib.getZ(i))) { bad = i; break; }
    if (bad < 0) continue;
    const t = new THREE.Vector3();
    const info: string[] = [];
    for (const u of [0, 0.01, 0.5, 0.99, 1]) { e.spline.getTangentAt(u, t); const s = u * e.length; const k = widthScaleAt(e, s); info.push(`u=${u} tan=(${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)}) k=${k.toFixed(2)} off=${carriagewayOffsetAt(e, s, k).toFixed(1)}`); }
    console.log(key, e.id, "len", e.length.toFixed(0), "lanes", e.lanes, "badIdx", bad, "/", rib.count, "pads", !!e.padStart, !!e.padEnd, "taper", e.taperStartFt, e.taperEndFt, e.startScale, e.endScale);
    console.log("   ", info.join("\n    "));
  }
}
