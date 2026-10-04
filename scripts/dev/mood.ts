// How the drivers feel: flow combos and traffic rage in a real-city level. npx tsx scripts/dev/mood.ts <city-key> [seconds] [weaves]
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { cloneNetwork, createSim, HARNESS_SPEED } from "../sim/harness";

async function main() {
  const [key = "monterrey", secs = "300", weaves = "0"] = process.argv.slice(2);
  const sim = await createSim();
  sim.send({ type: "setRageWeaves", enabled: weaves === "1" });
  sim.load(cloneNetwork(REAL_CITY_DATA[key].network), 1337, HARNESS_SPEED);
  let maxRage = 0;
  let last = await sim.runUntil(20);
  for (let t = 20; t <= Number(secs); t += 5) {
    last = await sim.runUntil(t);
    maxRage = Math.max(maxRage, last.rageCount);
  }
  console.log(JSON.stringify({ key, weaves, trips: last.trips, combos: last.combos, maxRage, mph: Math.round(last.avgMph) }));
  process.exit(0);
}
void main();
