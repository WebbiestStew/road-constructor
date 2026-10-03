import fs from "node:fs";
import { ROAD_CLASSES } from "../../src/sim/roadClasses";
import type { EdgeSpec, NodeSpec } from "../../src/sim/types";
import { toShareHash } from "./hash";

const mw = ROAD_CLASSES.motorway;
const av = ROAD_CLASSES.avenue;
const variant = process.argv[2] ?? "merge";
const E = { type: "entry", demandVehPerHour: 1500 } as const;
const D = { type: "destination", targetSpeedMph: 30 } as const;
const edge = (id: string, from: string, to: string, interior: [number, number, number][], cls: typeof mw, zone?: EdgeSpec["zone"]): EdgeSpec => ({
  id, fromNodeId: from, toNodeId: to, interiorPoints: interior, roadClassId: cls.id, elevationLevelId: "ground", lanes: cls.lanesPerDirection, laneWidthFt: cls.laneWidthFt, speedLimitMph: cls.speedLimitMph, ...(zone ? { zone } : {}),
});
let nodes: NodeSpec[];
let edges: EdgeSpec[];
if (variant === "merge") {
  // on-ramp from the south-west peeling in alongside the highway and joining at the origin
  nodes = [{ id: "a", position: [-1100, 0, 0] }, { id: "m", position: [0, 0, 0] }, { id: "z", position: [1100, 0, 0] }, { id: "rin", position: [-1100, 0, 330] }];
  edges = [
    edge("h1", "a", "m", [], mw, E),
    edge("h2", "m", "z", [], mw, D),
    edge("ron", "rin", "m", [[-800, 0, 210], [-560, 0, 110], [-340, 0, 45], [-150, 0, 12]], av, { type: "entry", demandVehPerHour: 700 }),
  ];
} else {
  // off-ramp leaving the highway at the origin and curving away to the south-east
  nodes = [{ id: "a", position: [-1100, 0, 0] }, { id: "x", position: [0, 0, 0] }, { id: "z", position: [1100, 0, 0] }, { id: "rout", position: [1100, 0, 330] }];
  edges = [
    edge("h1", "a", "x", [], mw, E),
    edge("h2", "x", "z", [], mw, D),
    edge("roff", "x", "rout", [[150, 0, 12], [340, 0, 45], [560, 0, 110], [800, 0, 210]], av, D),
  ];
}
if (process.env.NORAMP) edges = edges.filter((e) => !e.id.startsWith("r"));
fs.writeFileSync(`/tmp/shots/${variant}_test.txt`, toShareHash({ nodes, edges }));
console.log("ok");
