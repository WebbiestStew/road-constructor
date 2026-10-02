// Calibrates a campaign level in the headless sim: npx tsx scripts/sim/level.ts <levelId> <variant,variant> [seed]
// Variants: none | fixed (the level's planted faults removed) | bus | bike | cross (crosswalks on the jaywalking roads) | oneway
import { buildHarborDrive, buildMidtown } from "../../src/sim/cities";
import { getScenarioById } from "../../src/sim/scenarios";
import type { NetworkSnapshot } from "../../src/sim/types";
import { cloneNetwork, createSim } from "./harness";

const [levelId, variantArg = "none", seed = "1337"] = process.argv.slice(2);
const variants = new Set(variantArg.split(","));

function fixedNetwork(id: string): NetworkSnapshot | null {
  if (id === "code-three" || id === "transit-street") return buildMidtown(false);
  if (id === "rainy-rush" || id === "school-run" || id === "first-shift") return buildHarborDrive(false);
  return null;
}

async function main() {
  const scenario = getScenarioById(levelId);
  if (!scenario) throw new Error(`no level ${levelId}`);
  let network = cloneNetwork(scenario.startingNetwork);
  if (variants.has("fixed")) {
    const fixed = fixedNetwork(levelId);
    if (fixed) {
      network = cloneNetwork(fixed);
      // keep what the level layered on top of the base city
      const jay = new Set(scenario.startingNetwork.edges.filter((e) => e.jaywalkers).map((e) => e.id));
      for (const e of network.edges) if (jay.has(e.id)) e.jaywalkers = true;
    }
  }
  for (const e of network.edges) {
    if (variants.has("bus") && e.lanes >= 2) e.reservedLane = "bus";
    if (variants.has("bike") && e.lanes >= 2) e.reservedLane = "bike";
    // Direction-limited variants, by which way the road runs on the map.
    const a = network.nodes.find((n) => n.id === e.fromNodeId)!.position;
    const b = network.nodes.find((n) => n.id === e.toNodeId)!.position;
    const ew = Math.abs(b[0] - a[0]) > Math.abs(b[2] - a[2]);
    if (variants.has("busEW") && ew && e.lanes >= 2) e.reservedLane = "bus";
    if (variants.has("busNS") && !ew && e.lanes >= 2) e.reservedLane = "bus";
    if (variants.has("cross") && e.jaywalkers) e.crosswalk = true;
    if (variants.has("stops") && e.lanes >= 2) e.busStop = true;
    if (variants.has("parking") && e.lanes >= 2) e.parking = true;
  }
  const sim = await createSim();
  const g = globalThis as unknown as { postMessage: (m: any) => void };
  let last: any = null;
  const prev = g.postMessage;
  g.postMessage = (m: any) => {
    if (m.type === "tick") last = m;
    prev(m);
  };
  sim.send({ type: "setTrafficMix", bus: scenario.trafficMix?.bus ?? 0, bike: scenario.trafficMix?.bike ?? 0 });
  sim.load(network, Number(seed), 20);
  if (scenario.scriptedEvents) sim.send({ type: "scheduleEvents", events: scenario.scriptedEvents });
  const r = await sim.runUntil(scenario.durationS);
  const em = last?.emergency;
  console.log(
    JSON.stringify({
      level: levelId,
      variant: variantArg,
      trips: r.trips,
      people: Math.round(last?.peopleMovedTotal ?? 0),
      incidents: last?.pedIncidentsTotal ?? 0,
      peds: last?.pedServedTotal ?? 0,
      amb: em ? `${em.completed}/${em.dispatched} x${em.totalIdealS ? (em.totalResponseS / em.totalIdealS).toFixed(2) : "-"}` : "-",
      mph: Math.round(r.avgMph),
    })
  );
  process.exit(0);
}
void main();
