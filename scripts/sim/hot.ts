// Where does a real-city level jam? Runs it and lists the most congested roads with where they are.
//   npx tsx scripts/sim/hot.ts <city> [seconds]
import fs from "node:fs";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";
import { cloneNetwork, createSim, HARNESS_SPEED } from "./harness";
const [key, secs = "600"] = process.argv.slice(2);
async function main() {
  const data = REAL_CITY_DATA[key];
  const network = cloneNetwork(data.network);
  const sim = await createSim();
  const g = globalThis as unknown as { postMessage: (m: any) => void };
  const prev = g.postMessage;
  const acc = new Map<string, { n: number; veh: number; mph: number }>();
  g.postMessage = (m: any) => {
    if (m.type === "tick" && m.simTime > 60) for (const s of m.stats?.edgeTrafficStats ?? []) {
      const a = acc.get(s.edgeId) ?? { n: 0, veh: 0, mph: 0 };
      a.n++; a.veh += s.vehicleCount; a.mph += s.avgSpeedMph; acc.set(s.edgeId, a);
    }
    prev(m);
  };
  sim.load(network, 1337, HARNESS_SPEED);
  await sim.runUntil(Number(secs));
  const net = assembleNetwork(network);
  const [s, w, n, e] = data.meta.bbox;
  const lat0 = (s + n) / 2, lon0 = (w + e) / 2;
  const ll = (x: number, z: number) => [lat0 - z / (110540 * 3.28084), lon0 + x / (Math.cos((lat0 * Math.PI) / 180) * 111320 * 3.28084)].map((v) => +v.toFixed(4)).join(",");
  const signalAt = new Map(network.nodes.filter((nn) => nn.control?.type === "signal").map((nn) => [nn.id, 1]));
  const rows = net.edges.map((ed) => {
    const a = acc.get(ed.id);
    const veh = a ? a.veh / a.n : 0, mph = a ? a.mph / a.n : ed.speedLimitMph;
    const p = ed.spline.getPointAt(0.5);
    return { id: ed.id.slice(0, 14), veh, mph, lim: ed.speedLimitMph, len: ed.length, lanes: ed.lanes, cls: ed.roadClassId, at: ll(p.x, p.z), sig: signalAt.has(ed.toNodeId), el: ed.elevationLevelId, score: veh * Math.max(0, 1 - mph / ed.speedLimitMph) };
  }).sort((a, b) => b.score - a.score).slice(0, 25);
  for (const r of rows) console.log(`${r.at.padEnd(18)} ${r.cls.padEnd(8)} L${r.lanes} ${String(Math.round(r.len)).padStart(5)}ft veh ${r.veh.toFixed(1).padStart(5)} ${Math.round(r.mph)}/${r.lim}mph signalEnd=${r.sig} ${r.el}`);
  fs.writeFileSync("/tmp/hot.json", JSON.stringify(rows));
  process.exit(0);
}
void main();
