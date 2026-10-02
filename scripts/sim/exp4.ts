// Crash experiment: how long do crashes last in a city, fixed vs not? npx tsx scripts/sim/exp4.ts <levelId> <variant>
import { getScenarioById } from "../../src/sim/scenarios";
import { buildHarborDrive, buildMidtown } from "../../src/sim/cities";
import { cloneNetwork, createSim } from "./harness";
const [id = "midtown", variant = "none"] = process.argv.slice(2);
async function main() {
  const scenario = getScenarioById(id)!;
  const network = cloneNetwork(variant === "fixed" ? (id.includes("harbor") ? buildHarborDrive(false) : buildMidtown(false)) : scenario.startingNetwork);
  const sim = await createSim();
  let last: any = null;
  const g = globalThis as any;
  const prev = g.postMessage;
  g.postMessage = (m: any) => { if (m.type === "tick") last = m; prev(m); };
  sim.load(network, 1337, 20);
  sim.send({ type: "scheduleEvents", events: [40, 100, 160, 220].map((atS) => ({ atS, kind: "crash" as const })) });
  const r = await sim.runUntil(330);
  const c = last.crashes;
  console.log(JSON.stringify({ id, variant, trips: r.trips, happened: c.happened, cleared: c.cleared, open: c.open, avgClearS: c.cleared ? Math.round(c.totalClearS / c.cleared) : null }));
  process.exit(0);
}
void main();
