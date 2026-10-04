// Replays the messages the browser sends before a run, to see which one moves the result.
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { cloneNetwork, createSim, HARNESS_SPEED } from "../sim/harness";
const [key, variant = "browser"] = process.argv.slice(2);
async function main() {
  const network = cloneNetwork(REAL_CITY_DATA[key].network);
  const sim = await createSim();
  if (variant === "browser") {
    sim.send({ type: "setMaxVehicles", value: Number(process.env.CAP ?? 1000) });
    sim.send({ type: "setWeather", weather: "clear" } as never);
    sim.send({ type: "setDayCycle", enabled: false, startHour: 6, dayLengthS: 480 } as never);
    sim.send({ type: "setTransit", lines: [] } as never);
    sim.send({ type: "setTrafficMix", bus: 0, bike: 0 });
    sim.send({ type: "reset" } as never);
  }
  sim.send({ type: "setSpeedMultiplier", value: HARNESS_SPEED });
  sim.send({ type: "updateNetwork", network, seed: 1337 });
  sim.send({ type: "setRunning", running: true });
  const r = await sim.runUntil(300);
  console.log(variant, JSON.stringify({ trips: r.trips, mph: Math.round(r.avgMph) }));
  process.exit(0);
}
void main();
