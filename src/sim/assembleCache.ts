import { assembleNetwork } from "./network";
import type { EdgeSpec, NodeSpec, RoadNetwork } from "./types";

let lastNodes: NodeSpec[] | null = null;
let lastEdges: EdgeSpec[] | null = null;
let lastNetwork: RoadNetwork | null = null;

/** assembleNetwork, memoised on the identity of the node/edge arrays — the renderer and the lane/junction panels share one assembly per edit. */
export function assembleCached(nodes: NodeSpec[], edges: EdgeSpec[]): RoadNetwork {
  if (lastNetwork && nodes === lastNodes && edges === lastEdges) return lastNetwork;
  lastNetwork = assembleNetwork({ nodes, edges });
  lastNodes = nodes;
  lastEdges = edges;
  return lastNetwork;
}
