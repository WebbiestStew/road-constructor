import { REAL_CITY_DATA } from "../../src/sim/real";
import { assembleNetwork } from "../../src/sim/network";
for (const key of Object.keys(REAL_CITY_DATA)) {
  const net = assembleNetwork(REAL_CITY_DATA[key].network);
  let humps = 0, worst = 0, wid = "";
  for (const e of net.edges) {
    const ys: number[] = [];
    for (let i = 0; i <= 20; i++) ys.push(e.spline.getPointAt(i / 20).y);
    const lo = Math.min(ys[0], ys[20]), hi = Math.max(ys[0], ys[20]);
    const over = Math.max(Math.max(...ys) - hi, lo - Math.min(...ys)); // how far the road leaves the band between its end heights
    if (over > 2 && !e.sunken) { humps++; if (over > worst) { worst = over; wid = `${e.id.slice(0, 16)} len=${e.length.toFixed(0)} ends=${ys[0].toFixed(1)}/${ys[20].toFixed(1)} over=${over.toFixed(1)}`; } }
  }
  console.log(key.padEnd(12), "edges leaving their end-height band by >2ft:", humps, "worst:", wid);
}
