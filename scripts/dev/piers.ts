import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
import { computePierDescriptors, indexPierConflicts } from "../../src/components/roadGeometry";
for (const key of Object.keys(REAL_CITY_DATA)) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  indexPierConflicts(net.edges);
  let all = 0, kept = 0;
  for (const e of net.edges) { all += computePierDescriptors(e, 90, true).length; kept += computePierDescriptors(e).length; }
  console.log(`${key.padEnd(12)} piers ${all} -> ${kept} (removed ${all - kept})`);
}
