// Child-process entry: loads one real city (optionally with a variant applied), runs 300 sim-seconds, prints JSON.
// The worker is a singleton per process, which is why the tests shell out to this instead of running in-process.
import { REAL_CITY_DATA } from "../../src/sim/real";
import { cloneNetwork, createSim } from "./harness";

const [key, variant = "none", seed = "1337"] = process.argv.slice(2);

async function main() {
  const network = cloneNetwork(REAL_CITY_DATA[key].network);
  if (variant === "lanes") {
    for (const e of network.edges) if (!e.isRoundaboutRing && e.lanes < 4) e.lanes += 1;
  }
  const sim = await createSim();
  sim.load(network, Number(seed), 20);
  const r = await sim.runUntil(300);
  console.log(JSON.stringify({ trips: r.trips, mph: r.avgMph, jams: r.problems.length }));
  process.exit(0);
}
void main();
