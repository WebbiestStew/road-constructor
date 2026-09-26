"use client";

import * as THREE from "three";
import { create } from "zustand";
import { computeSignalPhaseGroups } from "@/sim/network";
import {
  DEMOLISH_REFUND_FRACTION,
  ROAD_CLASSES,
  ROUNDABOUT_LANE_WIDTH_FT,
  ROUNDABOUT_SPEED_MPH,
  type ElevationLevelId,
  type RoadClassId,
  estimateEdgeCost,
} from "@/sim/roadClasses";
import type {
  EdgeSpec,
  JunctionControl,
  NetworkSnapshot,
  NodeSpec,
  ZoneSpec,
} from "@/sim/types";

export type EditorMode = "build" | "simulate";
export type EditorTool = "draw" | "delete" | "inspect" | "zone";

export type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

export const STARTING_BUDGET = 2_000_000;

function edgeLengthFt(
  fromPos: [number, number, number],
  toPos: [number, number, number],
  interiorPoints: [number, number, number][]
): number {
  const points = [new THREE.Vector3(...fromPos), ...interiorPoints.map((p) => new THREE.Vector3(...p)), new THREE.Vector3(...toPos)];
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
  return curve.getLength();
}

function reversePoints(points: [number, number, number][]): [number, number, number][] {
  return [...points].reverse();
}

interface EditorState {
  mode: EditorMode;
  tool: EditorTool;
  selectedRoadClassId: RoadClassId;
  selectedElevationId: ElevationLevelId;
  twoWay: boolean;

  nodes: NodeSpec[];
  edges: EdgeSpec[];
  nodesById: Map<string, NodeSpec>;
  edgesById: Map<string, EdgeSpec>;

  budget: number;
  selection: Selection;
  drawFromNodeId: string | null;

  nextNodeSeq: number;
  nextEdgeSeq: number;

  setMode: (mode: EditorMode) => void;
  setTool: (tool: EditorTool) => void;
  setRoadClass: (id: RoadClassId) => void;
  setElevation: (id: ElevationLevelId) => void;
  setTwoWay: (v: boolean) => void;
  setSelection: (s: Selection) => void;

  startDrawChain: (nodeId: string) => void;
  cancelDrawChain: () => void;

  createNodeAt: (position: [number, number, number]) => string;
  findNearbyNode: (position: [number, number, number], snapFt: number) => string | null;

  /** Draws a road from an existing node to a new/target point, extending the chain. Returns the terminal node id. */
  drawTo: (fromNodeId: string, toNodeId: string | null, toPosition: [number, number, number]) => string;

  splitEdgeAt: (edgeId: string, worldPosition: [number, number, number]) => string;

  deleteEdge: (edgeId: string) => void;
  deleteNode: (nodeId: string) => void;

  setEdgeLanes: (edgeId: string, lanes: number) => void;
  setEdgeOneWay: (edgeId: string, oneWay: boolean) => void;
  setEdgeRoadClass: (edgeId: string, roadClassId: RoadClassId) => void;
  cycleEdgeZone: (edgeId: string) => void;
  setEntryDemand: (edgeId: string, vehiclesPerHour: number) => void;
  setDestinationTarget: (edgeId: string, targetSpeedMph: number) => void;

  setNodeControl: (nodeId: string, control: JunctionControl | undefined) => void;

  /** Replaces a junction node with an auto-generated roundabout ring, re-pointing its existing approach roads to the ring. */
  convertNodeToRoundabout: (nodeId: string, radiusFt?: number) => void;

  clearNetwork: () => void;
  getSnapshot: () => NetworkSnapshot;
}

function findCounterpart(edges: EdgeSpec[], edge: EdgeSpec): EdgeSpec | undefined {
  return edges.find((e) => e.fromNodeId === edge.toNodeId && e.toNodeId === edge.fromNodeId);
}

export const useEditorStore = create<EditorState>((set, get) => ({
  mode: "build",
  tool: "draw",
  selectedRoadClassId: "street",
  selectedElevationId: "ground",
  twoWay: true,

  nodes: [],
  edges: [],
  nodesById: new Map(),
  edgesById: new Map(),

  budget: STARTING_BUDGET,
  selection: null,
  drawFromNodeId: null,

  nextNodeSeq: 1,
  nextEdgeSeq: 1,

  setMode: (mode) => set({ mode, drawFromNodeId: null }),
  setTool: (tool) => set({ tool, drawFromNodeId: null, selection: null }),
  setRoadClass: (id) => set({ selectedRoadClassId: id }),
  setElevation: (id) => set({ selectedElevationId: id }),
  setTwoWay: (v) => set({ twoWay: v }),
  setSelection: (s) => set({ selection: s }),

  startDrawChain: (nodeId) => set({ drawFromNodeId: nodeId }),
  cancelDrawChain: () => set({ drawFromNodeId: null }),

  createNodeAt: (position) => {
    const id = `n${get().nextNodeSeq}`;
    const node: NodeSpec = { id, position };
    set((s) => {
      const nodes = [...s.nodes, node];
      const nodesById = new Map(s.nodesById);
      nodesById.set(id, node);
      return { nodes, nodesById, nextNodeSeq: s.nextNodeSeq + 1 };
    });
    return id;
  },

  findNearbyNode: (position, snapFt) => {
    const [x, , z] = position;
    let best: string | null = null;
    let bestDist = snapFt;
    for (const n of get().nodes) {
      const dx = n.position[0] - x;
      const dz = n.position[2] - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestDist) {
        bestDist = d;
        best = n.id;
      }
    }
    return best;
  },

  drawTo: (fromNodeId, toNodeId, toPosition) => {
    const state = get();
    const fromNode = state.nodesById.get(fromNodeId);
    if (!fromNode) return fromNodeId;

    const targetNodeId = toNodeId ?? state.createNodeAt(toPosition);
    const targetNode = get().nodesById.get(targetNodeId)!;

    const roadClass = ROAD_CLASSES[state.selectedRoadClassId];
    const lengthFt = edgeLengthFt(fromNode.position, targetNode.position, []);
    const cost = estimateEdgeCost(
      state.selectedRoadClassId,
      state.selectedElevationId,
      lengthFt,
      roadClass.lanesPerDirection
    );
    const totalCost = state.twoWay ? cost * 2 : cost;

    const forwardId = `e${get().nextEdgeSeq}`;
    const forward: EdgeSpec = {
      id: forwardId,
      fromNodeId,
      toNodeId: targetNodeId,
      interiorPoints: [],
      roadClassId: state.selectedRoadClassId,
      elevationLevelId: state.selectedElevationId,
      lanes: roadClass.lanesPerDirection,
      laneWidthFt: roadClass.laneWidthFt,
      speedLimitMph: roadClass.speedLimitMph,
    };

    const newEdges: EdgeSpec[] = [forward];
    let seq = get().nextEdgeSeq + 1;

    if (state.twoWay) {
      const backward: EdgeSpec = {
        id: `e${seq}`,
        fromNodeId: targetNodeId,
        toNodeId: fromNodeId,
        interiorPoints: [],
        roadClassId: state.selectedRoadClassId,
        elevationLevelId: state.selectedElevationId,
        lanes: roadClass.lanesPerDirection,
        laneWidthFt: roadClass.laneWidthFt,
        speedLimitMph: roadClass.speedLimitMph,
      };
      newEdges.push(backward);
      seq += 1;
    }

    set((s) => {
      const edges = [...s.edges, ...newEdges];
      const edgesById = new Map(s.edgesById);
      for (const e of newEdges) edgesById.set(e.id, e);
      return {
        edges,
        edgesById,
        nextEdgeSeq: seq,
        budget: s.budget - totalCost,
        drawFromNodeId: targetNodeId,
      };
    });

    return targetNodeId;
  },

  splitEdgeAt: (edgeId, worldPosition) => {
    const state = get();
    const edge = state.edgesById.get(edgeId);
    if (!edge) return "";

    const newNodeId = state.createNodeAt(worldPosition);
    const partA: EdgeSpec = {
      ...edge,
      id: `e${get().nextEdgeSeq}`,
      toNodeId: newNodeId,
      interiorPoints: [],
    };
    const partB: EdgeSpec = {
      ...edge,
      id: `e${get().nextEdgeSeq + 1}`,
      fromNodeId: newNodeId,
      interiorPoints: [],
    };

    const counterpart = findCounterpart(get().edges, edge);
    const extraNew: EdgeSpec[] = [];
    let seq = get().nextEdgeSeq + 2;
    let removeIds = [edge.id];

    if (counterpart) {
      const cPartA: EdgeSpec = {
        ...counterpart,
        id: `e${seq}`,
        fromNodeId: newNodeId,
        interiorPoints: [],
      };
      const cPartB: EdgeSpec = {
        ...counterpart,
        id: `e${seq + 1}`,
        toNodeId: newNodeId,
        interiorPoints: [],
      };
      extraNew.push(cPartA, cPartB);
      seq += 2;
      removeIds = [...removeIds, counterpart.id];
    }

    set((s) => {
      const kept = s.edges.filter((e) => !removeIds.includes(e.id));
      const edges = [...kept, partA, partB, ...extraNew];
      const edgesById = new Map(s.edgesById);
      for (const id of removeIds) edgesById.delete(id);
      for (const e of [partA, partB, ...extraNew]) edgesById.set(e.id, e);
      return { edges, edgesById, nextEdgeSeq: seq };
    });

    return newNodeId;
  },

  deleteEdge: (edgeId) => {
    const edge = get().edgesById.get(edgeId);
    if (!edge) return;
    const node = get().nodesById.get(edge.fromNodeId);
    const toNode = get().nodesById.get(edge.toNodeId);
    const lengthFt = node && toNode ? edgeLengthFt(node.position, toNode.position, edge.interiorPoints) : 0;
    const cost = estimateEdgeCost(edge.roadClassId, edge.elevationLevelId, lengthFt, edge.lanes);
    set((s) => {
      const edges = s.edges.filter((e) => e.id !== edgeId);
      const edgesById = new Map(s.edgesById);
      edgesById.delete(edgeId);
      return { edges, edgesById, budget: s.budget + cost * DEMOLISH_REFUND_FRACTION };
    });
  },

  deleteNode: (nodeId) => {
    const connected = get().edges.filter((e) => e.fromNodeId === nodeId || e.toNodeId === nodeId);
    for (const e of connected) get().deleteEdge(e.id);
    set((s) => {
      const nodes = s.nodes.filter((n) => n.id !== nodeId);
      const nodesById = new Map(s.nodesById);
      nodesById.delete(nodeId);
      return { nodes, nodesById };
    });
  },

  setEdgeLanes: (edgeId, lanes) => {
    const edge = get().edgesById.get(edgeId);
    if (!edge) return;
    const clamped = Math.max(1, Math.min(6, Math.round(lanes)));
    if (clamped === edge.lanes) return;
    const node = get().nodesById.get(edge.fromNodeId);
    const toNode = get().nodesById.get(edge.toNodeId);
    const lengthFt = node && toNode ? edgeLengthFt(node.position, toNode.position, edge.interiorPoints) : 0;
    const oldCost = estimateEdgeCost(edge.roadClassId, edge.elevationLevelId, lengthFt, edge.lanes);
    const newCost = estimateEdgeCost(edge.roadClassId, edge.elevationLevelId, lengthFt, clamped);
    const updated: EdgeSpec = { ...edge, lanes: clamped };
    set((s) => {
      const edges = s.edges.map((e) => (e.id === edgeId ? updated : e));
      const edgesById = new Map(s.edgesById);
      edgesById.set(edgeId, updated);
      return { edges, edgesById, budget: s.budget - (newCost - oldCost) };
    });
  },

  setEdgeOneWay: (edgeId, oneWay) => {
    const state = get();
    const edge = state.edgesById.get(edgeId);
    if (!edge) return;
    const counterpart = findCounterpart(state.edges, edge);

    if (oneWay) {
      if (counterpart) state.deleteEdge(counterpart.id);
      return;
    }

    if (!counterpart) {
      const node = state.nodesById.get(edge.fromNodeId);
      const toNode = state.nodesById.get(edge.toNodeId);
      const lengthFt = node && toNode ? edgeLengthFt(node.position, toNode.position, edge.interiorPoints) : 0;
      const cost = estimateEdgeCost(edge.roadClassId, edge.elevationLevelId, lengthFt, edge.lanes);
      const backward: EdgeSpec = {
        id: `e${get().nextEdgeSeq}`,
        fromNodeId: edge.toNodeId,
        toNodeId: edge.fromNodeId,
        interiorPoints: reversePoints(edge.interiorPoints),
        roadClassId: edge.roadClassId,
        elevationLevelId: edge.elevationLevelId,
        lanes: edge.lanes,
        laneWidthFt: edge.laneWidthFt,
        speedLimitMph: edge.speedLimitMph,
      };
      set((s) => {
        const edges = [...s.edges, backward];
        const edgesById = new Map(s.edgesById);
        edgesById.set(backward.id, backward);
        return { edges, edgesById, nextEdgeSeq: s.nextEdgeSeq + 1, budget: s.budget - cost };
      });
    }
  },

  setEdgeRoadClass: (edgeId, roadClassId) => {
    const edge = get().edgesById.get(edgeId);
    if (!edge) return;
    const node = get().nodesById.get(edge.fromNodeId);
    const toNode = get().nodesById.get(edge.toNodeId);
    const lengthFt = node && toNode ? edgeLengthFt(node.position, toNode.position, edge.interiorPoints) : 0;
    const oldCost = estimateEdgeCost(edge.roadClassId, edge.elevationLevelId, lengthFt, edge.lanes);
    const cls = ROAD_CLASSES[roadClassId];
    const newCost = estimateEdgeCost(roadClassId, edge.elevationLevelId, lengthFt, cls.lanesPerDirection);
    const updated: EdgeSpec = {
      ...edge,
      roadClassId,
      lanes: cls.lanesPerDirection,
      laneWidthFt: cls.laneWidthFt,
      speedLimitMph: cls.speedLimitMph,
    };
    set((s) => {
      const edges = s.edges.map((e) => (e.id === edgeId ? updated : e));
      const edgesById = new Map(s.edgesById);
      edgesById.set(edgeId, updated);
      return { edges, edgesById, budget: s.budget - (newCost - oldCost) };
    });
  },

  cycleEdgeZone: (edgeId) => {
    const edge = get().edgesById.get(edgeId);
    if (!edge) return;
    let zone: ZoneSpec | undefined;
    if (!edge.zone) zone = { type: "entry", demandVehPerHour: 600 };
    else if (edge.zone.type === "entry") zone = { type: "destination", targetSpeedMph: 25 };
    else zone = undefined;
    const updated: EdgeSpec = { ...edge, zone };
    set((s) => {
      const edges = s.edges.map((e) => (e.id === edgeId ? updated : e));
      const edgesById = new Map(s.edgesById);
      edgesById.set(edgeId, updated);
      return { edges, edgesById };
    });
  },

  setEntryDemand: (edgeId, vehiclesPerHour) => {
    const edge = get().edgesById.get(edgeId);
    if (!edge || edge.zone?.type !== "entry") return;
    const updated: EdgeSpec = { ...edge, zone: { type: "entry", demandVehPerHour: vehiclesPerHour } };
    set((s) => {
      const edges = s.edges.map((e) => (e.id === edgeId ? updated : e));
      const edgesById = new Map(s.edgesById);
      edgesById.set(edgeId, updated);
      return { edges, edgesById };
    });
  },

  setDestinationTarget: (edgeId, targetSpeedMph) => {
    const edge = get().edgesById.get(edgeId);
    if (!edge || edge.zone?.type !== "destination") return;
    const updated: EdgeSpec = { ...edge, zone: { type: "destination", targetSpeedMph } };
    set((s) => {
      const edges = s.edges.map((e) => (e.id === edgeId ? updated : e));
      const edgesById = new Map(s.edgesById);
      edgesById.set(edgeId, updated);
      return { edges, edgesById };
    });
  },

  setNodeControl: (nodeId, control) => {
    const state = get();
    const node = state.nodesById.get(nodeId);
    if (!node) return;
    let resolvedControl = control;
    if (control?.type === "signal") {
      const { groupA, groupB } = computeSignalPhaseGroups(nodeId, state.edges, state.nodesById);
      resolvedControl = { type: "signal", groupA, groupB, greenDurationS: 20, allRedDurationS: 2 };
    }
    const updated: NodeSpec = { ...node, control: resolvedControl };
    set((s) => {
      const nodes = s.nodes.map((n) => (n.id === nodeId ? updated : n));
      const nodesById = new Map(s.nodesById);
      nodesById.set(nodeId, updated);
      return { nodes, nodesById };
    });
  },

  convertNodeToRoundabout: (nodeId, radiusFt) => {
    const state = get();
    const node = state.nodesById.get(nodeId);
    if (!node) return;

    const connected = state.edges.filter((e) => e.fromNodeId === nodeId || e.toNodeId === nodeId);
    if (connected.length === 0) return;

    const legMap = new Map<string, EdgeSpec[]>();
    for (const e of connected) {
      const otherId = e.fromNodeId === nodeId ? e.toNodeId : e.fromNodeId;
      const arr = legMap.get(otherId) ?? [];
      arr.push(e);
      legMap.set(otherId, arr);
    }
    if (legMap.size < 2) return;

    const angleOf = (otherId: string) => {
      const other = state.nodesById.get(otherId);
      if (!other) return 0;
      return Math.atan2(other.position[2] - node.position[2], other.position[0] - node.position[0]);
    };

    const legs = Array.from(legMap.entries())
      .map(([otherId, legEdges]) => ({ otherId, angle: angleOf(otherId), edges: legEdges }))
      .sort((a, b) => a.angle - b.angle);

    const radius = radiusFt ?? Math.max(45, legs.length * 16);
    const y = node.position[1];

    let nodeSeq = state.nextNodeSeq;
    const ringNodes: NodeSpec[] = legs.map((leg) => {
      const id = `n${nodeSeq++}`;
      const rx = node.position[0] + Math.cos(leg.angle) * radius;
      const rz = node.position[2] + Math.sin(leg.angle) * radius;
      return { id, position: [rx, y, rz] };
    });

    // Re-point every existing approach edge from the old center node to its dedicated ring node.
    const repointedById = new Map<string, EdgeSpec>();
    legs.forEach((leg, i) => {
      const ringNodeId = ringNodes[i].id;
      for (const e of leg.edges) {
        if (e.toNodeId === nodeId) repointedById.set(e.id, { ...e, toNodeId: ringNodeId });
        else repointedById.set(e.id, { ...e, fromNodeId: ringNodeId });
      }
    });

    // Ring edges connecting consecutive ring nodes, bowed out through the true arc midpoint so
    // the ring reads as a circle even with only 3-4 legs.
    let edgeSeq = state.nextEdgeSeq;
    let ringCost = 0;
    const ringEdges: EdgeSpec[] = [];
    for (let i = 0; i < legs.length; i++) {
      const a = legs[i];
      const fromNode = ringNodes[i];
      const toNode = ringNodes[(i + 1) % legs.length];
      const delta = (((legs[(i + 1) % legs.length].angle - a.angle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const midAngle = a.angle + delta / 2;
      const midPoint: [number, number, number] = [
        node.position[0] + Math.cos(midAngle) * radius,
        y,
        node.position[2] + Math.sin(midAngle) * radius,
      ];
      const length = edgeLengthFt(fromNode.position, toNode.position, [midPoint]);
      ringCost += estimateEdgeCost("lane", "ground", length, 1);
      ringEdges.push({
        id: `e${edgeSeq++}`,
        fromNodeId: fromNode.id,
        toNodeId: toNode.id,
        interiorPoints: [midPoint],
        roadClassId: "lane",
        elevationLevelId: "ground",
        lanes: 1,
        laneWidthFt: ROUNDABOUT_LANE_WIDTH_FT,
        speedLimitMph: ROUNDABOUT_SPEED_MPH,
        isRoundaboutRing: true,
      });
    }

    set((s) => {
      const edges = [
        ...s.edges.filter((e) => !repointedById.has(e.id)),
        ...Array.from(repointedById.values()),
        ...ringEdges,
      ];
      const nodes = [...s.nodes.filter((n) => n.id !== nodeId), ...ringNodes];
      const nodesById = new Map(s.nodesById);
      nodesById.delete(nodeId);
      for (const rn of ringNodes) nodesById.set(rn.id, rn);
      const edgesById = new Map(s.edgesById);
      for (const e of repointedById.values()) edgesById.set(e.id, e);
      for (const e of ringEdges) edgesById.set(e.id, e);
      return {
        nodes,
        edges,
        nodesById,
        edgesById,
        nextNodeSeq: nodeSeq,
        nextEdgeSeq: edgeSeq,
        budget: s.budget - ringCost,
        selection: null,
      };
    });
  },

  clearNetwork: () =>
    set({
      nodes: [],
      edges: [],
      nodesById: new Map(),
      edgesById: new Map(),
      budget: STARTING_BUDGET,
      selection: null,
      drawFromNodeId: null,
      nextNodeSeq: 1,
      nextEdgeSeq: 1,
    }),

  getSnapshot: () => {
    const s = get();
    return { nodes: s.nodes, edges: s.edges } satisfies NetworkSnapshot;
  },
}));
