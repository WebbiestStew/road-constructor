// Scratch experiments: npx tsx scripts/sim/exp.ts <city> <variant>
import { REAL_CITY_DATA } from "../../src/sim/real";
import { cloneNetwork, createSim } from "./harness";
const [key, variant = "none"] = process.argv.slice(2);
async function main() {
  const network = cloneNetwork(REAL_CITY_DATA[key].network);
  if (variant === "bus" || variant === "bike") {
    for (const e of network.edges) if (e.lanes >= 3 && !e.isRoundaboutRing && e.roadClassId !== "motorway" && e.roadClassId !== "highway") (e as any).reservedLane = variant;
  }
  if (variant === "busall") for (const e of network.edges) if (e.lanes >= 2 && !e.isRoundaboutRing) (e as any).reservedLane = "bus";
  const sim = await createSim();
  sim.send({ type: "setTrafficMix", bus: 0.06, bike: 0.05 });
  sim.load(network, 1337, 20);
  const r = await sim.runUntil(300);
  console.log(JSON.stringify({ key, variant, trips: r.trips, people: Math.round(r.people), mph: Math.round(r.avgMph), jams: r.problems.length }));
  process.exit(0);
}
void main();
