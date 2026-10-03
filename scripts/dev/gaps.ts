import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
const key = process.argv[2] ?? "chicago";
const net = assembleNetwork(REAL_CITY_DATA[key].network);
for (const e of net.edges) for (const [name, pad] of [["start", e.padStart], ["end", e.padEnd]] as const) {
  if (!pad) continue;
  const g = pad.gap; const n = g.length;
  const wide = g.filter((v) => v > 24).length, mid = g.filter((v) => v >= 1.2 && v <= 24).length;
  console.log(e.id.slice(0, 22).padEnd(22), name.padEnd(5), "samples", n, "gap<=24:", mid, ">24:", wide, "max", Math.max(...g).toFixed(0), "adjUntil", pad.adjacentUntil.toFixed(0), "at", e.spline.getPointAt(name === "start" ? 0 : 1).x.toFixed(0), e.spline.getPointAt(name === "start" ? 0 : 1).z.toFixed(0));
}
