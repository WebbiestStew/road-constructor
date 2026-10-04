// Cost of a widening variant against the level's budget: npx tsx scripts/sim/cost.ts <city> <maxLanes>
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { REAL_PLANS } from "../../src/sim/scenarios";
import { estimateEdgeCost } from "../../src/sim/roadClasses";
const [key, maxLanes = "5"] = process.argv.slice(2);
const net = REAL_CITY_DATA[key].network;
const nodes = new Map(net.nodes.map((n) => [n.id, n]));
let cost = 0, widened = 0;
for (const e of net.edges) {
  if (e.isRoundaboutRing || e.lanes >= Number(maxLanes)) continue;
  const a = nodes.get(e.fromNodeId)!.position, b = nodes.get(e.toNodeId)!.position;
  let len = 0, prev = a;
  for (const p of [...e.interiorPoints, b]) { len += Math.hypot(p[0] - prev[0], p[2] - prev[2]); prev = p; }
  cost += estimateEdgeCost(e.roadClassId, e.elevationLevelId, len, e.lanes + 1) - estimateEdgeCost(e.roadClassId, e.elevationLevelId, len, e.lanes);
  widened++;
}
const plan = REAL_PLANS.find((p) => p.key === key)!;
console.log(key, "widen", widened, "of", net.edges.length, "roads to <=", maxLanes, "cost $" + cost.toLocaleString(), "budget $" + plan.budget.toLocaleString(), (100 * cost / plan.budget).toFixed(0) + "%");
