// Checks which edge line of a merging ramp faces the through road, against the line the mesh suppresses.
import * as THREE from "three";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
import { carriagewayOffsetAt, widthScaleAt } from "../../src/sim/laneGeometry";
const key = process.argv[2] ?? "chicago";
const net = assembleNetwork(REAL_CITY_DATA[key].network);
let ok = 0, bad = 0;
for (const e of net.edges) for (const [atEnd, pad] of [[false, e.padStart], [true, e.padEnd]] as const) {
  if (!pad || pad.adjacentUntil < 60) continue;
  const d = Math.min(pad.adjacentUntil * 0.5, e.length * 0.5);
  const dist = atEnd ? e.length - d : d;
  const u = dist / e.length;
  const p = e.spline.getPointAt(u), t = e.spline.getTangentAt(u);
  const l = Math.hypot(t.x, t.z) || 1, rx = -t.z / l, rz = t.x / l;
  const k = widthScaleAt(e, dist), off = carriagewayOffsetAt(e, dist, k);
  const hr = (e.lanes * e.laneWidthFt) / 2 * k;
  const lineAt = (s: number) => ({ x: p.x + rx * (off + s * hr), z: p.z + rz * (off + s * hr) });
  // nearest main edge point: mainEdge samples at index d/JOIN_STEP
  const i = Math.min(pad.mainEdge.length / 3 - 1, Math.round(d / 10));
  const m = { x: pad.mainEdge[i * 3], z: pad.mainEdge[i * 3 + 2] };
  const dm = Math.hypot(lineAt(-1).x - m.x, lineAt(-1).z - m.z), dp = Math.hypot(lineAt(1).x - m.x, lineAt(1).z - m.z);
  const facing = dm < dp ? -1 : 1;
  const suppressed = pad.awaySign; // as RoadNetworkMesh uses innerSide
  if (facing === suppressed) ok++; else bad++;
}
console.log(key, "suppressed line faces main:", ok, "wrong side:", bad);
