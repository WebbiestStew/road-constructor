import fs from "node:fs";
import { Builder } from "../../src/sim/cityBuilder";
import { toShareHash } from "./hash";
const b = new Builder();
b.node("w", -700, 0); b.node("e", 700, 0);
b.road(0, "a", "w", "e", "avenue", "ground", { forward: { type: "entry", demandVehPerHour: 900 }, backward: { type: "destination", targetSpeedMph: 20 } });
for (const e of b.edges) { (e as any).busStop = true; (e as any).parking = true; }
fs.writeFileSync("/tmp/shots/props_test.txt", toShareHash({ nodes: [...b.nodes.values()], edges: b.edges }));
