// Records a run with player actions and plays it back: npx tsx scripts/sim/replay.ts record <out.json> | play <in.json>
// The two halves run in separate processes (the worker is a singleton per process), and must agree to the vehicle.
// Both step the sim directly (no timers), so every action lands at exactly the same sim time in both.
import fs from "node:fs";
import { getScenarioById } from "../../src/sim/scenarios";
import { cloneNetwork, createSim } from "./harness";
import type { LoggedAction } from "../../src/sim/types";
(globalThis as unknown as { __simDebug: Record<string, unknown> }).__simDebug = {};

const [mode, file] = process.argv.slice(2);
type Debug = { advance: (t: number) => void; actions: () => LoggedAction[]; totals: () => { simTime: number; trips: number; people: number; delayS: number; spawned: number; active: number } };

async function main() {
  const level = getScenarioById("harbor-drive")!;
  const sim = await createSim();
  const dbg = (globalThis as unknown as { __simDebug: Debug }).__simDebug;
  const series: [number, number, number][] = [];
  const sample = (t: number) => {
    dbg.advance(t);
    const x = dbg.totals();
    series.push([Math.round(x.simTime * 1000), x.trips, x.spawned]);
  };
  if (mode === "record") {
    // what the browser sends when a level is opened to traffic
    sim.send({ type: "reset" });
    sim.send({ type: "updateNetwork", network: cloneNetwork(level.startingNetwork), seed: 1337 });
    sim.send({ type: "setLeftTurnsYield", enabled: false });
    sim.send({ type: "setRageWeaves", enabled: false });
    for (let t = 10; t <= 240; t += 10) {
      sample(t);
      const edges = level.startingNetwork.edges;
      if (t === 40) sim.send({ type: "patchEdges", edges: [{ id: edges[0].id, speedLimitMph: 25, laneMoves: null, bannedTurns: ["left"] }] });
      if (t === 70) {
        sim.send({ type: "breakdown", durationS: 20 });
        sim.send({ type: "setWeather", weather: "rain" });
      }
      if (t === 110) {
        sim.send({ type: "ambulance" });
        sim.send({ type: "setDarkness", level: 1 });
      }
      if (t === 150) {
        sim.send({ type: "setWeather", weather: "clear" });
        sim.send({ type: "crash" });
      }
    }
    const x = dbg.totals();
    fs.writeFileSync(file, JSON.stringify({ actions: dbg.actions(), series, final: x }));
    console.log(JSON.stringify({ recordedActions: dbg.actions().length, ...x }));
  } else {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { actions: LoggedAction[]; series: [number, number, number][]; final: Record<string, number> };
    sim.send({ type: "reset" });
    sim.send({ type: "replay", actions: saved.actions });
    for (let t = 10; t <= 240; t += 10) sample(t);
    const x = dbg.totals();
    const differing = series.filter((row, i) => row[1] !== saved.series[i][1] || row[2] !== saved.series[i][2] || row[0] !== saved.series[i][0]).length;
    const same = differing === 0 && x.trips === saved.final.trips && Math.round(x.people) === Math.round(saved.final.people) && Math.round(x.delayS) === Math.round(saved.final.delayS);
    console.log(JSON.stringify({ replayedActions: saved.actions.length, samples: series.length, differing, same, trips: x.trips, recordedTrips: saved.final.trips, people: Math.round(x.people), delayS: Math.round(x.delayS) }));
  }
  process.exit(0);
}
void main();
