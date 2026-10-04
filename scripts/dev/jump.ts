import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";
import { carriagewayOffsetAt, widthScaleAt } from "../../src/sim/laneGeometry";
const [key, prefix] = [process.argv[2], process.argv[3]];
const net = assembleNetwork(REAL_CITY_DATA[key].network);
for (const e of net.edges.filter((x) => x.id.startsWith(prefix))) {
  console.log(e.id, "len", e.length.toFixed(0), "lanes", e.lanes, "ls", e.lateralShiftFt);
  for (const [name, pad] of [["start", e.padStart], ["end", e.padEnd]] as const) if (pad) console.log(name, "gap", pad.gap.map((g) => g.toFixed(0)).join(" "), "| reach", pad.reach, "mainHalf", pad.mainHalf, "away", pad.awaySign);
  const row: string[] = [];
  for (let s = 0; s <= e.length; s += 10) { const k = widthScaleAt(e, s); row.push(carriagewayOffsetAt(e, s, k).toFixed(0)); }
  console.log("offsets:", row.join(" "));
}
