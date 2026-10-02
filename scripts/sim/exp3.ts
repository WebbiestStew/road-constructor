// Ambulance experiment on Houston: response time vs ideal, with and without extra lanes.
import { REAL_CITY_DATA } from "../../src/sim/real";
import { cloneNetwork, createSim } from "./harness";
const [key, variant = "none"] = process.argv.slice(2);
async function main() {
  const network = cloneNetwork(REAL_CITY_DATA[key].network);
  if (variant === "lanes") for (const e of network.edges) if (!e.isRoundaboutRing && e.lanes < 4) e.lanes += 1;
  const sim = await createSim();
  let em: any = null;
  const g = globalThis as any;
  const prev = g.postMessage;
  g.postMessage = (m: any) => { if (m.type === "tick") em = m.emergency; prev(m); };
  sim.load(network, 1337, 20);
  sim.send({ type: "scheduleEvents", events: [60, 120, 180, 240].map((atS) => ({ atS, kind: "ambulance" as const })) });
  const r = await sim.runUntil(330);
  console.log(JSON.stringify({ key, variant, trips: r.trips, em, ratio: em && em.totalIdealS ? +(em.totalResponseS / em.totalIdealS).toFixed(2) : null }));
  process.exit(0);
}
void main();
