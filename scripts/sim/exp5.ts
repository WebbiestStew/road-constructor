// Bus line experiment: npx tsx scripts/sim/exp5.ts <headwayS|0>
import { buildMidtown } from "../../src/sim/cities";
import { assembleNetwork, computeRoute } from "../../src/sim/network";
import { createSim } from "./harness";
const headway = Number(process.argv[2] ?? 0);
async function main() {
  const net = buildMidtown(false);
  const asm = assembleNetwork(net);
  const entry = asm.edges.find((e) => e.zone?.type === "entry")!;
  const dest = asm.edges.filter((e) => e.zone?.type === "destination" && computeRoute(asm, entry.id, e.id)).sort((a, b) => computeRoute(asm, entry.id, b.id)!.length - computeRoute(asm, entry.id, a.id)!.length)[0];
  const route = computeRoute(asm, entry.id, dest.id)!;
  const sim = await createSim();
  let last: any = null;
  const g = globalThis as any;
  const prev = g.postMessage;
  g.postMessage = (m: any) => { if (m.type === "tick") last = m; prev(m); };
  sim.load(net, 1337, 20);
  if (headway > 0) sim.send({ type: "setTransit", lines: [{ id: "t1", name: "Line 1", edgeIds: route, headwayS: headway, color: "#f00" }] });
  const r = await sim.runUntil(300);
  console.log(JSON.stringify({ headway, routeEdges: route.length, trips: r.trips, people: Math.round(last.peopleMovedTotal) }));
  process.exit(0);
}
void main();
