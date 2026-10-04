import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { cloneNetwork, createSim, HARNESS_SPEED } from "../sim/harness";
const key = process.argv[2];
async function main() {
  const sim = await createSim();
  sim.load(cloneNetwork(REAL_CITY_DATA[key].network), 1337, HARNESS_SPEED);
  const out: string[] = [];
  for (const t of [20, 40, 60, 80, 100, 120, 150]) { const r = await sim.runUntil(t); out.push(`${t}s:${r.trips}/${r.activeCount}v`); }
  console.log(key, out.join("  "));
  process.exit(0);
}
void main();
