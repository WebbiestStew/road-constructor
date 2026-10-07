// A fingerprint of what assembleNetwork produces for every real city and classic level (lengths, curve samples, exits), to prove a speed-up changed nothing.
import { createHash } from "node:crypto";
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { SCENARIOS } from "../../src/sim/scenarios";
import { assembleNetwork } from "../../src/sim/network";
import type { NetworkSnapshot } from "../../src/sim/types";

function digest(net: NetworkSnapshot): string {
  const h = createHash("sha256");
  const a = assembleNetwork(net);
  for (const e of a.edges) {
    h.update(`${e.id}|${e.length.toFixed(6)}|${e.nextEdgeIds.join(",")}|${e.isElevated}|${e.sunken}|${e.lateralShiftFt}|`);
    for (const t of [0, 0.13, 0.5, 0.87, 1]) {
      const p = e.spline.getPointAt(t);
      h.update(`${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)};`);
    }
  }
  return h.digest("hex").slice(0, 12);
}

const out: string[] = [];
for (const [key, city] of Object.entries(REAL_CITY_DATA)) out.push(`${key}:${digest(city.network)}`);
for (const s of SCENARIOS) if (!s.real) out.push(`${s.id}:${digest(s.startingNetwork)}`);
console.log(createHash("sha256").update(out.join("\n")).digest("hex").slice(0, 16));
if (process.argv.includes("--all")) console.log(out.join("\n"));
