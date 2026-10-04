// Does a jam keep draining? Trips completed in each 100 s window of a long run: npx tsx scripts/sim/drain.ts <city> [totalSeconds]
import { REAL_CITY_DATA } from "../../src/sim/real/all";
const [key, total = "700"] = process.argv.slice(2);
async function main() {
  const { cloneNetwork, createSim } = await import("./harness");
  const sim = await createSim();
  sim.load(cloneNetwork(REAL_CITY_DATA[key].network), 1337, 20);
  const windows: number[] = [];
  let prev = 0;
  for (let t = 100; t <= Number(total); t += 100) {
    const r = await sim.runUntil(t);
    windows.push(r.trips - prev);
    prev = r.trips;
  }
  console.log(key.padEnd(12), "trips per 100 s:", windows.join(", "));
  process.exit(0);
}
void main();
