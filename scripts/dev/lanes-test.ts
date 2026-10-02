import fs from "node:fs";
import { Builder } from "../../src/sim/cityBuilder";
import { toShareHash } from "./hash";

const b = new Builder();
b.node("w", -900, 0); b.node("m", 0, 0); b.node("e", 900, 0);
b.node("s", 0, 700); b.node("n", 0, -700);
const D = { type: "destination", targetSpeedMph: 20 } as const;
const E = (v: number) => ({ type: "entry", demandVehPerHour: v }) as const;
b.road(0, "a1", "w", "m", "avenue", "ground", { forward: E(900), backward: D });
b.road(0, "a2", "m", "e", "avenue", "ground", { forward: D, backward: E(900) });
b.road(0, "c1", "n", "m", "street", "ground", { forward: E(300), backward: D });
b.road(0, "c2", "m", "s", "street", "ground", { forward: D, backward: E(300) });
for (const e of b.edges) {
  if (e.id === "a1f") (e as any).reservedLane = "bus";
  if (e.id === "a1b") (e as any).reservedLane = "bus";
  if (e.id === "a2f") (e as any).reservedLane = "bike";
  if (e.id === "a2b") (e as any).reservedLane = "bike";
  if (e.id === "c1f" || e.id === "c1b") (e as any).crosswalk = true;
}
fs.writeFileSync("/tmp/shots/lanes_test.txt", toShareHash({ nodes: [...b.nodes.values()], edges: b.edges }));
console.log("ok");
