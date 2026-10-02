import fs from "node:fs";
import { Builder } from "../../src/sim/cityBuilder";
import { toShareHash } from "./hash";
const b = new Builder();
b.node("w", -500, 0); b.node("e", 500, 0);
b.road(0, "a", "w", "e", "avenue", "ground", { forward: { type: "entry", demandVehPerHour: 700 }, backward: { type: "destination", targetSpeedMph: 20 } });
for (const e of b.edges) { (e as any).crosswalk = true; (e as any).jaywalkers = true; }
fs.writeFileSync("/tmp/shots/ped_test.txt", toShareHash({ nodes: [...b.nodes.values()], edges: b.edges }));
