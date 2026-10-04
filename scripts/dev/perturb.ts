// Same seed, same traffic, but the first node nudged by a hair: how much does a jammed map's result move?
import { REAL_CITY_DATA } from "../../src/sim/real";
import { cloneNetwork, createSim, HARNESS_SPEED } from "../sim/harness";
const [key, eps] = process.argv.slice(2);
async function main() {
  const network = cloneNetwork(REAL_CITY_DATA[key].network);
  network.nodes[0].position[0] += Number(eps);
  const sim = await createSim();
  sim.load(network, 1337, HARNESS_SPEED);
  const r = await sim.runUntil(300);
  console.log(key, "eps", eps, "trips", r.trips);
  process.exit(0);
}
void main();
