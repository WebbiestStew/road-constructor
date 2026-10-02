// What is a jam waiting on? npx tsx scripts/sim/stuck.ts <city> [seconds]
import { REAL_CITY_DATA } from "../../src/sim/real";
const [key, secs = "240"] = process.argv.slice(2);
const dbg: Record<string, any> = {};
(globalThis as any).__simDebug = dbg;
async function main() {
  const { cloneNetwork, createSim } = await import("./harness");
  const sim = await createSim();
  sim.load(cloneNetwork(REAL_CITY_DATA[key].network), 1337, 20);
  await sim.runUntil(Number(secs));
  const st = dbg.state();
  const net = st.network;
  const rows: Record<string, number> = {};
  let stuck = 0, total = 0;
  for (const v of st.vehicles.values()) {
    total++;
    if (v.speed > 2) continue;
    stuck++;
    const edge = net.edgesById.get(v.edgeId);
    if (!edge) continue;
    const toEnd = edge.length - v.distanceAlongEdge;
    const stop = dbg.stopFor(v, edge);
    const gap = stop.gap.gap;
    let why = "leader";
    if (stop.junction !== null && stop.junction <= gap + 0.5) {
      const node = net.nodesById.get(edge.toNodeId);
      why = node?.control?.type === "signal" ? "signal red" : "priority yield";
    } else if (stop.wrongLane !== null && stop.wrongLane <= gap + 0.5) why = "wrong lane";
    else if (stop.crossing !== null) why = "crossing";
    else if (stop.busStop !== null) why = "bus stop";
    else if (gap > 60) {
      const t = Math.min(1, Math.max(0, v.distanceAlongEdge / edge.length));
      const tan = edge.spline.getTangentAt(t);
      why = `free road: ${v.kind} speed ${v.speed.toFixed(1)} grade ${(tan.y * 100).toFixed(1)}% lane ${v.laneIndex}`;
    }
    rows[why] = (rows[why] ?? 0) + 1;
  }
  console.log(JSON.stringify({ key, total, stuck, rows }, null, 1));
  process.exit(0);
}
void main();
