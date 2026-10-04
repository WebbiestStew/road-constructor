// Checks the heap-based computeRoute against the original scan-based one on many pairs.
import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork, computeRoute } from "../../src/sim/network";
import type { RoadNetwork } from "../../src/sim/types";
const mph = (m: number) => (m * 5280) / 3600;
function oldRoute(network: RoadNetwork, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const start = network.edgesById.get(from);
  if (!start || !network.edgesById.has(to)) return null;
  const tt = (e: { length: number; speedLimitMph: number }) => e.length / Math.max(mph(e.speedLimitMph), 1);
  const dist = new Map<string, number>(), prev = new Map<string, string>(), visited = new Set<string>();
  dist.set(from, tt(start));
  for (;;) {
    let cur: string | null = null, cd = Infinity;
    for (const [id, d] of dist) if (!visited.has(id) && d < cd) { cd = d; cur = id; }
    if (cur === null || cur === to) break;
    visited.add(cur);
    const ce = network.edgesById.get(cur);
    if (!ce) continue;
    for (const n of ce.nextEdgeIds) {
      if (visited.has(n)) continue;
      const ne = network.edgesById.get(n);
      if (!ne) continue;
      const c = cd + tt(ne);
      if (c < (dist.get(n) ?? Infinity)) { dist.set(n, c); prev.set(n, cur); }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to]; let cur = to;
  while (cur !== from) { const p = prev.get(cur); if (!p) return null; path.push(p); cur = p; }
  return path.reverse();
}
let pairs = 0, diff = 0;
for (const key of ["atlanta", "monterrey", "lincoln-tunnel", "los-angeles"]) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  const ids = net.edges.map((e) => e.id);
  const entries = net.edges.filter((e) => e.zone?.type === "entry").map((e) => e.id);
  const dests = net.edges.filter((e) => e.zone?.type === "destination").map((e) => e.id);
  const list: [string, string][] = [];
  for (const a of entries) for (const b of dests) list.push([a, b]);
  for (let i = 0; i < 150; i++) list.push([ids[(i * 7919) % ids.length], ids[(i * 104729 + 13) % ids.length]]);
  for (const [a, b] of list) {
    pairs++;
    if (JSON.stringify(oldRoute(net, a, b)) !== JSON.stringify(computeRoute(net, a, b))) diff++;
  }
}
console.log("pairs", pairs, "different", diff);
