import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { assembleNetwork } from "../../src/sim/network";
import { buildGores } from "../../src/components/roadGeometry";
const variant = process.argv[2] ?? "exit";
const payload = JSON.parse(gunzipSync(Buffer.from(fs.readFileSync(`/tmp/shots/${variant}_test.txt`, "utf8"), "base64url")).toString());
const net = assembleNetwork(payload.network);
for (const e of net.edges) {
  for (const g of buildGores(e)) {
    const pos = g.pave.getAttribute("position");
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < pos.count; i++) { minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i)); minZ = Math.min(minZ, pos.getZ(i)); maxZ = Math.max(maxZ, pos.getZ(i)); }
    const hp = g.hatching.getAttribute("position");
    console.log(e.id, "hatch tris", hp.count / 3, "| gore pave x", minX.toFixed(0), maxX.toFixed(0), "z", minZ.toFixed(0), maxZ.toFixed(0), "tris", pos.count / 3);
  }
}
import { buildAsphaltRibbon } from "../../src/components/roadGeometry";
for (const e of net.edges) {
  const g = buildAsphaltRibbon(e, 4, 0);
  const pos = g.getAttribute("position");
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < pos.count; i++) { minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i)); minZ = Math.min(minZ, pos.getZ(i)); maxZ = Math.max(maxZ, pos.getZ(i)); }
  console.log("ribbon", e.id.padEnd(5), "x", minX.toFixed(0), maxX.toFixed(0), "z", minZ.toFixed(1), maxZ.toFixed(1), "lanes", e.lanes, "laneW", e.laneWidthFt);
}
