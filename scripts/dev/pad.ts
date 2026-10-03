import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { assembleNetwork } from "../../src/sim/network";
const variant = process.argv[2] ?? "exit";
const payload = JSON.parse(gunzipSync(Buffer.from(fs.readFileSync(`/tmp/shots/${variant}_test.txt`, "utf8"), "base64url")).toString());
const net = assembleNetwork(payload.network);
for (const e of net.edges) {
  for (const [name, pad] of [["start", e.padStart], ["end", e.padEnd]] as const) {
    if (!pad) continue;
    console.log(e.id, name, "reach", pad.reach, "mainHalf", pad.mainHalf, "away", pad.awaySign, "side", pad.sideOfMain, "adjacentUntil", pad.adjacentUntil);
    console.log("  gap:", pad.gap.filter((_, i) => i % 4 === 0).map((g) => g.toFixed(1)).join(" "));
  }
}
