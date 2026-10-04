// Picks where a player should add lanes: runs the untouched city, finds the busiest congested roads, and widens them
// best-value-first until the budget is spent. Writes /tmp/plan-<city>.json for run.ts ("plan" variant).
//   npx tsx scripts/sim/plan.ts <city> [budgetFraction]
import fs from "node:fs";
import { REAL_CITY_DATA } from "../../src/sim/real";
import { REAL_PLANS } from "../../src/sim/scenarios";
import { estimateEdgeCost } from "../../src/sim/roadClasses";
import { cloneNetwork, createSim, HARNESS_SPEED } from "./harness";

const [key, frac = "0.95"] = process.argv.slice(2);
async function main() {
  const plan0 = REAL_PLANS.find((p) => p.key === key)!;
  const network = cloneNetwork(REAL_CITY_DATA[key].network);
  const sim = await createSim();
  const g = globalThis as unknown as { postMessage: (m: any) => void };
  const prev = g.postMessage;
  const acc = new Map<string, { n: number; veh: number; vc: number; mph: number }>();
  g.postMessage = (m: any) => {
    if (m.type === "tick" && m.simTime > 30) {
      for (const s of m.stats?.edgeTrafficStats ?? []) {
        const a = acc.get(s.edgeId) ?? { n: 0, veh: 0, vc: 0, mph: 0 };
        a.n++; a.veh += s.vehicleCount; a.vc += s.vcRatio; a.mph += s.avgSpeedMph;
        acc.set(s.edgeId, a);
      }
    }
    prev(m);
  };
  sim.load(network, 1337, HARNESS_SPEED);
  await sim.runUntil(Math.min(600, plan0.durationS ?? 300));
  const nodes = new Map(network.nodes.map((n) => [n.id, n]));
  const plan = REAL_PLANS.find((p) => p.key === key)!;
  const rows = network.edges
    .filter((e) => !e.isRoundaboutRing && e.lanes < 6)
    .map((e) => {
      const a = acc.get(e.id);
      const veh = a ? a.veh / a.n : 0, mph = a ? a.mph / a.n : e.speedLimitMph;
      const slow = Math.max(0, 1 - mph / Math.max(1, e.speedLimitMph));
      const A = nodes.get(e.fromNodeId)!.position, B = nodes.get(e.toNodeId)!.position;
      let len = 0, p0 = A;
      for (const p of [...e.interiorPoints, B]) { len += Math.hypot(p[0] - p0[0], p[2] - p0[2]); p0 = p; }
      const cost = estimateEdgeCost(e.roadClassId, e.elevationLevelId, len, e.lanes + 1) - estimateEdgeCost(e.roadClassId, e.elevationLevelId, len, e.lanes);
      return { id: e.id, veh, vc: slow, cost, score: (veh * slow) / Math.max(1, cost) };
    })
    .filter((r) => r.veh > 0.5 && r.vc > 0.25)
    .sort((x, y) => y.score - x.score);
  const vcs = [...acc.values()].map((a) => a.vc / a.n).sort((x, y) => y - x);
  
  let spent = 0;
  const widen: string[] = [];
  for (const r of rows) {
    if (spent + r.cost > plan.budget * Number(frac)) continue;
    spent += r.cost;
    widen.push(r.id);
  }
  fs.writeFileSync(`/tmp/plan-${key}.json`, JSON.stringify({ widen }));
  console.log(key, "candidates", rows.length, "widened", widen.length, "spent $" + spent.toLocaleString(), "of $" + plan.budget.toLocaleString());
  process.exit(0);
}
void main();
