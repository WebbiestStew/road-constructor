import * as THREE from "three";
import {
  DEFAULT_LANE_WIDTH_FT,
  type Edge3D,
  type EdgeKind,
  type EntryPointDef,
  type Node3D,
  type RoadNetwork,
  type RouteDef,
} from "./types";

/**
 * Demo network: a closed-loop 2-lane divided mainline ("highway oval")
 * featuring one grade-separated overpass, two single-lane off-ramps, and a
 * Texas turnaround that loops ramp traffic back under the overpass to
 * re-merge onto the mainline. All coordinates are in feet; y is elevation.
 *
 * Layout (plan view, x = longitudinal, z = lateral):
 *
 *        C=====D            (bridge deck, y=24)
 *       /       \
 *   B--/         \--E------F
 *   |                        \
 *   A                         (curve)
 *   |                        /
 *   J------I------H---------
 *        \
 *   M (ramp merge) -- turnaround loop under bridge -- back to A
 *
 * Off-ramp 1 branches from node E (just past the overpass, eastbound).
 * Off-ramp 2 branches from node I (on the return leg, before the bridge).
 * Both ramps converge at node M, which feeds the Texas turnaround edge
 * that passes back under the bridge (y=0, well below the y=24 deck) and
 * re-merges onto the mainline at node A, closing the loop.
 */

interface NodeSpec {
  id: string;
  position: [number, number, number];
}

interface EdgeSpec {
  id: string;
  from: string;
  to: string;
  /** Interior shaping points (not graph nodes), in order, between from and to. */
  interior?: [number, number, number][];
  lanes: number;
  speedLimitMph: number;
  laneWidthFt?: number;
  kind: EdgeKind;
}

const NODES: NodeSpec[] = [
  { id: "A", position: [-2600, 0, 0] },
  { id: "B", position: [-1200, 0, 0] },
  { id: "C", position: [-300, 24, 0] },
  { id: "D", position: [300, 24, 0] },
  { id: "E", position: [1000, 0, 0] },
  { id: "F", position: [2400, 0, 0] },
  { id: "H", position: [2400, 0, 600] },
  { id: "I", position: [1000, 0, 600] },
  { id: "J", position: [-1200, 0, 600] },
  { id: "M", position: [300, 0, -260] },
];

const EDGES: EdgeSpec[] = [
  { id: "e_AB", from: "A", to: "B", lanes: 2, speedLimitMph: 65, kind: "mainline" },
  {
    id: "e_bridge_w",
    from: "B",
    to: "C",
    lanes: 2,
    speedLimitMph: 55,
    kind: "mainline",
  },
  {
    id: "e_bridge",
    from: "C",
    to: "D",
    lanes: 2,
    speedLimitMph: 55,
    kind: "overpass",
  },
  {
    id: "e_bridge_e",
    from: "D",
    to: "E",
    lanes: 2,
    speedLimitMph: 55,
    kind: "mainline",
  },
  { id: "e_EF", from: "E", to: "F", lanes: 2, speedLimitMph: 65, kind: "mainline" },
  {
    id: "e_curveE",
    from: "F",
    to: "H",
    interior: [[3000, 0, 300]],
    lanes: 2,
    speedLimitMph: 45,
    kind: "mainline",
  },
  { id: "e_HI", from: "H", to: "I", lanes: 2, speedLimitMph: 65, kind: "mainline" },
  { id: "e_IJ", from: "I", to: "J", lanes: 2, speedLimitMph: 65, kind: "mainline" },
  {
    id: "e_curveW",
    from: "J",
    to: "A",
    interior: [[-2000, 0, 300]],
    lanes: 2,
    speedLimitMph: 45,
    kind: "mainline",
  },
  {
    id: "e_ramp1",
    from: "E",
    to: "M",
    interior: [
      [1150, 0, -140],
      [700, 0, -260],
    ],
    lanes: 1,
    speedLimitMph: 35,
    laneWidthFt: 13,
    kind: "ramp",
  },
  {
    id: "e_ramp2",
    from: "I",
    to: "M",
    interior: [
      [700, 0, 300],
      [500, 0, 0],
    ],
    lanes: 1,
    speedLimitMph: 35,
    laneWidthFt: 13,
    kind: "ramp",
  },
  {
    id: "e_turnaround",
    from: "M",
    to: "A",
    interior: [
      [0, 0, -340],
      [-400, 0, -260],
      [-1200, 0, -140],
      [-2000, 0, -40],
    ],
    lanes: 1,
    speedLimitMph: 30,
    laneWidthFt: 13,
    kind: "turnaround",
  },
];

const ROUTE_THROUGH: string[] = [
  "e_AB",
  "e_bridge_w",
  "e_bridge",
  "e_bridge_e",
  "e_EF",
  "e_curveE",
  "e_HI",
  "e_IJ",
  "e_curveW",
];

const ROUTE_RAMP1: string[] = [
  "e_AB",
  "e_bridge_w",
  "e_bridge",
  "e_bridge_e",
  "e_EF",
  "e_ramp1",
  "e_turnaround",
];

const ROUTE_RAMP2: string[] = [
  "e_AB",
  "e_bridge_w",
  "e_bridge",
  "e_bridge_e",
  "e_EF",
  "e_curveE",
  "e_HI",
  "e_ramp2",
  "e_turnaround",
];

const ELEVATION_SAMPLE_STEPS = 24;
const ELEVATION_THRESHOLD_FT = 1;

function buildSpline(spec: EdgeSpec, nodeById: Map<string, NodeSpec>): THREE.CatmullRomCurve3 {
  const fromNode = nodeById.get(spec.from);
  const toNode = nodeById.get(spec.to);
  if (!fromNode || !toNode) {
    throw new Error(`Edge ${spec.id} references unknown node`);
  }
  const points: THREE.Vector3[] = [new THREE.Vector3(...fromNode.position)];
  for (const p of spec.interior ?? []) {
    points.push(new THREE.Vector3(...p));
  }
  points.push(new THREE.Vector3(...toNode.position));
  return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
}

function computeIsElevated(curve: THREE.CatmullRomCurve3): boolean {
  const p = new THREE.Vector3();
  for (let i = 0; i <= ELEVATION_SAMPLE_STEPS; i++) {
    curve.getPointAt(i / ELEVATION_SAMPLE_STEPS, p);
    if (p.y > ELEVATION_THRESHOLD_FT) return true;
  }
  return false;
}

let cachedNetwork: RoadNetwork | null = null;

/**
 * Builds the demo road network. Pure and deterministic — safe to call
 * independently from both the main thread (for mesh generation) and the
 * simulation worker (for vehicle routing), always producing identical
 * geometry without needing to serialize THREE objects across the
 * postMessage boundary.
 */
export function buildNetwork(): RoadNetwork {
  if (cachedNetwork) return cachedNetwork;

  const nodeById = new Map(NODES.map((n) => [n.id, n]));

  const edges: Edge3D[] = EDGES.map((spec) => {
    const spline = buildSpline(spec, nodeById);
    const length = spline.getLength();
    return {
      id: spec.id,
      fromNodeId: spec.from,
      toNodeId: spec.to,
      spline,
      lanes: spec.lanes,
      laneWidthFt: spec.laneWidthFt ?? DEFAULT_LANE_WIDTH_FT,
      speedLimitMph: spec.speedLimitMph,
      length,
      kind: spec.kind,
      nextEdgeIds: [],
      isElevated: computeIsElevated(spline),
    };
  });

  const edgesById = new Map(edges.map((e) => [e.id, e]));
  for (const edge of edges) {
    edge.nextEdgeIds = edges
      .filter((e2) => e2.fromNodeId === edge.toNodeId)
      .map((e2) => e2.id);
  }

  const nodes: Node3D[] = NODES.map((n) => ({ id: n.id, position: n.position }));

  const makeRoute = (id: string, edgeIds: string[], weight: number): RouteDef => ({
    id,
    edgeIds,
    weight,
  });

  const entries: EntryPointDef[] = [
    {
      id: "entry_A",
      label: "Mainline West Entry",
      edgeId: "e_AB",
      laneIndex: 0,
      routes: [
        makeRoute("through", ROUTE_THROUGH, 0.7),
        makeRoute("ramp1_turnaround", ROUTE_RAMP1, 0.15),
        makeRoute("ramp2_turnaround", ROUTE_RAMP2, 0.15),
      ],
    },
  ];

  cachedNetwork = { nodes, edges, edgesById, entries };
  return cachedNetwork;
}

/** Picks a weighted-random route from a list, using the supplied RNG (defaults to Math.random). */
export function pickWeightedRoute(routes: RouteDef[], rng: () => number = Math.random): RouteDef {
  const total = routes.reduce((sum, r) => sum + r.weight, 0);
  let roll = rng() * total;
  for (const route of routes) {
    if (roll < route.weight) return route;
    roll -= route.weight;
  }
  return routes[routes.length - 1];
}
