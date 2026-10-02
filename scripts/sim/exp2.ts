// Pedestrian crossing experiment: a single avenue with a busy flow, with and without a crossing.
import { Builder } from "../../src/sim/cityBuilder";
import { createSim } from "./harness";
const variant = process.argv[2] ?? "none";
async function main() {
  const b = new Builder();
  b.node("w", -1500, 0); b.node("e", 1500, 0);
  b.road(0, "a", "w", "e", "avenue", "ground", { forward: { type: "entry", demandVehPerHour: 1100 }, backward: { type: "destination", targetSpeedMph: 20 } });
  for (const e of b.edges) {
    if (variant !== "plain") (e as any).jaywalkers = true;
    if (variant === "cross") (e as any).crosswalk = true;
  }
  const sim = await createSim();
  let ped = 0, inc = 0;
  const g = globalThis as any;
  const prev = g.postMessage;
  g.postMessage = (m: any) => { if (m.type === "tick") { ped = m.pedServedTotal; inc = m.pedIncidentsTotal; } prev(m); };
  sim.load({ nodes: [...b.nodes.values()], edges: b.edges }, 1337, 20);
  const r = await sim.runUntil(300);
  console.log(JSON.stringify({ variant, trips: r.trips, mph: Math.round(r.avgMph), ped, inc }));
  process.exit(0);
}
void main();
