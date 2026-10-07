import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";
for (const [key, city] of Object.entries(REAL_CITY_DATA)) {
  const net = city.network;
  const t0 = performance.now();
  assembleNetwork(net);
  const t1 = performance.now();
  console.log(key.padEnd(34), String(net.edges.length).padStart(5), "edges", (t1 - t0).toFixed(0).padStart(6), "ms");
}
