// Which cut roads can the entries of a baked real city actually reach? Prints lat/lon so a level's zones can be chosen.
import fs from "node:fs";
import { assembleNetwork, computeRoute } from "../../src/sim/network";
const key = process.argv[2] ?? "lincoln-tunnel";
const d = JSON.parse(fs.readFileSync(`src/sim/real/${key}.json`, "utf8"));
const net = assembleNetwork(d.network);
const [s, w, n, e] = d.meta.bbox;
const lat0 = (s + n) / 2, lon0 = (w + e) / 2;
const ll = (x: number, z: number) => [lat0 - z / (110540 * 3.28084), lon0 + x / (Math.cos((lat0 * Math.PI) / 180) * 111320 * 3.28084)].map((v) => +v.toFixed(4));
const entries = net.edges.filter((x) => x.zone?.type === "entry");
console.log("entries", entries.length);
const nb = new Map<string, Set<string>>();
for (const x of net.edges) for (const [a, b] of [[x.fromNodeId, x.toNodeId], [x.toNodeId, x.fromNodeId]]) (nb.get(a) ?? nb.set(a, new Set()).get(a)!).add(b);
const deadEnds = net.edges.filter((x) => (nb.get(x.toNodeId)?.size ?? 0) === 1);
const entry = entries.find((x) => x.roadClassId === "motorway") ?? entries[0];
const rows: string[] = [];
for (const x of deadEnds) {
  const p = x.spline.getPointAt(1);
  const ok = computeRoute(net, entry.id, x.id);
  if (ok) rows.push(`${ll(p.x, p.z).join(",")} ${x.roadClassId} lanes ${x.lanes}`);
}
console.log("reachable dead-end exits from", entry.id.slice(0, 18), ":", rows.length, "of", deadEnds.length);
console.log(rows.sort().join("\n"));
