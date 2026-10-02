"use client";

import * as THREE from "three";
import { create } from "zustand";
import { assembleNetwork, assembleNetworkCached, computeSignalPhaseGroups, planTexasTurnaround, trafficStaysConnected } from "@/sim/network";
import { pushToast } from "@/lib/toast";
import { FREE_BUILD_ECONOMY_K, economyKFor, economyRates } from "@/sim/economy";
import { assembleCached } from "@/sim/assembleCache";
import { findClearanceViolations } from "@/sim/clearance";
import {
  DEMOLISH_REFUND_FRACTION,
  HOTKEY_TIER_IDS,
  ROAD_CLASSES,
  ROUNDABOUT_LANE_WIDTH_FT,
  ROUNDABOUT_SPEED_MPH,
  TEXAS_TURNAROUND_COST_MULTIPLIER,
  TEXAS_TURNAROUND_LANE_WIDTH_FT,
  TEXAS_TURNAROUND_MIN_RADIUS_FT,
  TEXAS_TURNAROUND_SEARCH_RADIUS_FT,
  TEXAS_TURNAROUND_SPEED_MPH,
  type ElevationLevelId,
  type RoadClassId,
  estimateEdgeCost,
} from "@/sim/roadClasses";
import type {
  EdgeSpec,
  JunctionControl,
  LaneMove,
  NetworkSnapshot,
  NodeSpec,
  ReservedLane,
  Weather,
  ZoneSpec,
} from "@/sim/types";
import {
  loadAutosave,
  saveAutosave,
  type PersistedPayload,
} from "./persistence";
import { playDemolish, playPlaceRoad } from "@/lib/sound";
import { SANDBOX_BUDGET, type ScenarioDef } from "@/sim/scenarios";

export type EditorMode = "build" | "simulate";
export type EditorTool = "draw" | "delete" | "inspect" | "zone" | "turnaround" | "lanes" | "speed" | "junction" | "street";

/** Tools that change how traffic is managed rather than what is built — these work while traffic is running. */
export const MANAGER_TOOLS: EditorTool[] = ["inspect", "lanes", "speed", "junction", "street"];

/** A crossing needs room for the approach and stopping distance on both sides. */
export const MIN_CROSSWALK_ROAD_FT = 110;
export const MIN_BUS_STOP_ROAD_FT = 150;

export interface TrafficMix {
  bus: number;
  bike: number;
}
export const CLASSIC_MIX: TrafficMix = { bus: 0, bike: 0 };
export const MIXED_MIX: TrafficMix = { bus: 0.06, bike: 0.05 };

export const SPEED_LIMIT_CHOICES_MPH = [15, 20, 25, 30, 35, 40, 45, 55, 65, 75];

export type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

/** Sandbox grants this much, which nobody can spend; anything above half of it is treated as "unlimited" by the UI. */
export const isSandboxBudget = (budget: number) => budget > SANDBOX_BUDGET / 2;

export const STARTING_BUDGET = 2_000_000;

function edgeLengthFt(
  fromPos: [number, number, number],
  toPos: [number, number, number],
  interiorPoints: [number, number, number][],
): number {
  const points = [
    new THREE.Vector3(...fromPos),
    ...interiorPoints.map((p) => new THREE.Vector3(...p)),
    new THREE.Vector3(...toPos),
  ];
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
  return curve.getLength();
}

function reversePoints(
  points: [number, number, number][],
): [number, number, number][] {
  return [...points].reverse();
}

interface HistoryEntry {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  budget: number;
  nextNodeSeq: number;
  nextEdgeSeq: number;
}

const MAX_HISTORY = 50;

interface EditorState {
  mode: EditorMode;
  tool: EditorTool;
  selectedRoadClassId: RoadClassId;
  selectedElevationId: ElevationLevelId;
  twoWay: boolean;
  heatmapEnabled: boolean;
  setHeatmapEnabled: (v: boolean) => void;
  timeOfDay: "day" | "dusk" | "night";
  setTimeOfDay: (v: "day" | "dusk" | "night") => void;
  /** Chase/ride-along camera: locks the view behind a live vehicle instead of the free orthographic overview. Only meaningful in Simulate mode. */
  rideAlongActive: boolean;
  setRideAlongActive: (v: boolean) => void;

  /** Transient user-facing message (e.g. a rejected clearance-violating road) — cleared automatically after a few seconds. */
  buildWarning: string | null;
  setBuildWarning: (message: string | null) => void;

  /** A one-shot request for the in-canvas camera controller to recenter on a network's bounding box center (e.g. right after loading a shared layout). */
  pendingCameraFit: { centerX: number; centerZ: number; radiusFt?: number } | null;
  requestCameraFit: (bounds: { centerX: number; centerZ: number; radiusFt?: number }) => void;
  clearPendingCameraFit: () => void;
  /** Steps the currently-selected elevation up/down the At-Grade -> Tier 3 ladder by one 20ft rung (the Q/E hotkeys). Has no effect while Tunnel/Cutting is selected. */
  stepElevation: (direction: -1 | 1) => void;

  nodes: NodeSpec[];
  edges: EdgeSpec[];
  nodesById: Map<string, NodeSpec>;
  edgesById: Map<string, EdgeSpec>;

  budget: number;
  selection: Selection;
  drawFromNodeId: string | null;

  nextNodeSeq: number;
  nextEdgeSeq: number;

  past: HistoryEntry[];
  future: HistoryEntry[];
  pushHistoryEntry: () => void;
  undo: () => void;
  redo: () => void;

  setMode: (mode: EditorMode) => void;
  setTool: (tool: EditorTool) => void;
  setRoadClass: (id: RoadClassId) => void;
  setElevation: (id: ElevationLevelId) => void;
  setTwoWay: (v: boolean) => void;
  setSelection: (s: Selection) => void;

  startDrawChain: (nodeId: string) => void;
  cancelDrawChain: () => void;

  createNodeAt: (position: [number, number, number]) => string;
  findNearbyNode: (
    position: [number, number, number],
    snapFt: number,
  ) => string | null;

  /** Draws a road from an existing node to a new/target point, extending the chain. Returns the terminal node id. */
  drawTo: (
    fromNodeId: string,
    toNodeId: string | null,
    toPosition: [number, number, number],
  ) => string;

  splitEdgeAt: (
    edgeId: string,
    worldPosition: [number, number, number],
  ) => string;

  deleteEdge: (edgeId: string) => void;
  deleteNode: (nodeId: string) => void;

  setEdgeLanes: (edgeId: string, lanes: number) => void;
  setEdgeOneWay: (edgeId: string, oneWay: boolean) => void;
  setEdgeRoadClass: (edgeId: string, roadClassId: RoadClassId) => void;
  cycleEdgeZone: (edgeId: string) => void;
  setEntryDemand: (edgeId: string, vehiclesPerHour: number) => void;
  setDestinationTarget: (edgeId: string, targetSpeedMph: number) => void;

  setNodeControl: (nodeId: string, control: JunctionControl | undefined) => void;
  setSignalTiming: (nodeId: string, greenDurationS: number) => void;
  /** Shifts where in its cycle a light starts, so neighbouring lights can be staggered into a green wave. */
  setSignalOffset: (nodeId: string, offsetS: number) => void;

  /** Sets one lane's permitted moves (traffic management: free, works live). Seeds the other lanes from the automatic assignment. */
  setLaneMoves: (edgeId: string, laneIndex: number, moves: LaneMove[]) => void;
  /** Drops the player's lane arrows on this edge so it goes back to automatic assignment. */
  resetLaneMoves: (edgeId: string) => void;
  /** Sets the speed limit on this segment, its opposite direction, and optionally the rest of the road it belongs to. */
  setSpeedLimit: (edgeId: string, mph: number, wholeRoad: boolean) => void;
  /** Sets aside the rightmost lane of a road (and its opposite carriageway) for buses or bikes; null gives it back to everyone. */
  setReservedLane: (edgeId: string, kind: ReservedLane | null, wholeRoad: boolean) => void;
  /** Makes a road one-way (in the selected direction) or restores its opposite carriageway. Refuses edits that would strand traffic. */
  setRoadOneWay: (edgeId: string, oneWay: boolean, wholeRoad: boolean) => void;
  /** Adds or removes a bus stop on this side of the road. */
  setBusStop: (edgeId: string, on: boolean) => void;
  /** Adds or removes street parking along this side of a road (and its opposite side, and optionally the rest of the road). */
  setParking: (edgeId: string, on: boolean, wholeRoad: boolean) => void;
  /** Adds or removes a mid-block pedestrian crossing on this segment and its opposite direction. */
  setCrosswalk: (edgeId: string, on: boolean) => void;

  /** Replaces a junction node with an auto-generated roundabout ring, re-pointing its existing approach roads to the ring. */
  convertNodeToRoundabout: (nodeId: string, radiusFt?: number) => void;

  /**
   * Splits the clicked edge and the nearest opposing (roughly anti-parallel)
   * frontage edge within range, then connects the two split points with a
   * one-way 180° slip-lane loop — a Texas turnaround. Sets `buildWarning`
   * and does nothing if no suitable opposing frontage road is nearby.
   */
  createTexasTurnaround: (edgeId: string, clickPoint: [number, number, number]) => void;

  clearNetwork: () => void;
  getSnapshot: () => NetworkSnapshot;
  exportPayload: () => PersistedPayload;
  importPayload: (payload: PersistedPayload) => void;
  /**
   * Applies any autosaved network, once, from a client-only effect after
   * mount — never at store-creation time. The store's initial state must be
   * identical on the server-rendered HTML and the client's first render (no
   * `localStorage` access), or React logs a hydration mismatch the moment a
   * returning player (who has autosave data) loads or reloads the page. A
   * silent no-op if there's nothing saved.
   */
  hydrateAutosave: () => void;

  /** Scale of the running costs (upkeep and parking income) in budgeted levels; null where money doesn't run out (sandbox, manage levels). */
  economyK: number | null;
  /** Charges (or credits) the budget for traffic having run `deltaS` sim-seconds with the current roads. */
  applyEconomy: (deltaS: number) => void;
  /** Name of the real-world place loaded with "Load any place", for the map credit; null otherwise. */
  placeName: string | null;
  /** Opens a real place's roads (from OpenStreetMap) as an open sandbox: unlimited money, nothing locked. */
  startPlace: (network: NetworkSnapshot, name: string) => void;
  /** The weather the player chose in free play (scripted storms in a level override it). */
  weather: Weather;
  setWeather: (w: Weather) => void;
  /** A 24-hour day: demand follows the rush hours and the lighting follows the clock. Free play only. */
  dayCycle: boolean;
  setDayCycle: (on: boolean) => void;
  /** Share of traffic that is buses and bikes (0 = the classic cars-and-trucks mix). Levels set it; the sandbox turns it on. */
  trafficMix: TrafficMix;
  setTrafficMix: (mix: TrafficMix) => void;

  activeScenarioId: string | null;
  /** True in a manage-only city: roads can't be built or changed, only traffic management tools work. */
  buildLocked: boolean;
  /** True while a real-city (OpenStreetMap) level is loaded: its stacked ramps legitimately overlap, so the clearance warning pills are hidden. */
  realCityActive: boolean;
  /** Bumped whenever a scenario (re)starts, so the simulation knows to start a fresh run even if the mode didn't change. */
  simEpoch: number;
  loadScenario: (scenario: ScenarioDef) => void;
  exitScenario: () => void;
  /** Clears the active scenario and grants an effectively-infinite budget, for continuing to play a won layout without constraints. */
  enterSandboxMode: () => void;
  /** Starts a clean Sandbox: empty map, nothing locked, and no money limit. */
  startSandbox: () => void;
}

function findCounterpart(
  edges: EdgeSpec[],
  edge: EdgeSpec,
): EdgeSpec | undefined {
  return edges.find(
    (e) => e.fromNodeId === edge.toNodeId && e.toNodeId === edge.fromNodeId,
  );
}

/**
 * The edges a road-wide edit applies to: just `edgeId`, or — when `wholeRoad` — everything reached by following
 * the road straight through junctions in both directions of travel while it stays the same class, plus the
 * opposite carriageway of every one of those.
 */
/** Re-derives every traffic light's phase groups after roads were added or removed, keeping its timing. */
function refreshSignals(nodes: NodeSpec[], edges: EdgeSpec[]): NodeSpec[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((n) => {
    if (n.control?.type !== "signal") return n;
    const { groupA, groupB } = computeSignalPhaseGroups(n.id, edges, nodesById);
    return { ...n, control: { ...n.control, groupA, groupB } };
  });
}

function collectRoadTargets(state: Pick<EditorState, "nodes" | "edges" | "edgesById">, edgeId: string, wholeRoad: boolean, includeCounterparts = true): Set<string> {
  const targets = new Set<string>();
  if (!state.edgesById.has(edgeId)) return targets;
  targets.add(edgeId);
  if (wholeRoad) {
    const network = assembleCached(state.nodes, state.edges);
    const queue = [edgeId];
    while (queue.length > 0) {
      const cur = network.edgesById.get(queue.pop()!);
      if (!cur || cur.isRoundaboutRing) continue;
      for (const [nextId, move] of cur.nextMoves) {
        const next = network.edgesById.get(nextId);
        if (move === "straight" && next && next.roadClassId === cur.roadClassId && !next.isRoundaboutRing && !targets.has(nextId)) {
          targets.add(nextId);
          queue.push(nextId);
        }
      }
      for (const other of network.edges) {
        if (targets.has(other.id) || other.isRoundaboutRing || other.roadClassId !== cur.roadClassId) continue;
        if (other.nextMoves.get(cur.id) === "straight") {
          targets.add(other.id);
          queue.push(other.id);
        }
      }
    }
  }
  // A two-way road's two carriageways are edited together.
  if (!includeCounterparts) return targets;
  for (const id of Array.from(targets)) {
    const e = state.edgesById.get(id);
    const back = e ? findCounterpart(state.edges, e) : undefined;
    if (back) targets.add(back.id);
  }
  return targets;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  mode: "build",
  tool: "draw",
  selectedRoadClassId: "street",
  selectedElevationId: "ground",
  twoWay: true,
  heatmapEnabled: false,
  setHeatmapEnabled: (v) => set({ heatmapEnabled: v }),
  timeOfDay: "day",
  setTimeOfDay: (v) => set({ timeOfDay: v }),
  rideAlongActive: false,
  setRideAlongActive: (v) => set({ rideAlongActive: v }),

  buildWarning: null,
  setBuildWarning: (message) => set({ buildWarning: message }),

  pendingCameraFit: null,
  requestCameraFit: (bounds) => set({ pendingCameraFit: bounds }),
  clearPendingCameraFit: () => set({ pendingCameraFit: null }),
  stepElevation: (direction) => {
    const current = get().selectedElevationId;
    const idx = HOTKEY_TIER_IDS.indexOf(current);
    if (idx === -1) return; // Tunnel/Cutting aren't on the hotkey ladder
    const nextIdx = Math.max(0, Math.min(HOTKEY_TIER_IDS.length - 1, idx + direction));
    set({ selectedElevationId: HOTKEY_TIER_IDS[nextIdx] });
  },

  // Always the same hard defaults here, matching the statically prerendered
  // HTML exactly — any autosave is applied post-mount by hydrateAutosave()
  // instead, never read at store-creation time (see that action's doc
  // comment for why).
  nodes: [],
  edges: [],
  nodesById: new Map(),
  edgesById: new Map(),

  budget: STARTING_BUDGET,
  selection: null,
  drawFromNodeId: null,

  nextNodeSeq: 1,
  nextEdgeSeq: 1,

  past: [],
  future: [],
  pushHistoryEntry: () => {
    const s = get();
    const entry: HistoryEntry = {
      nodes: s.nodes,
      edges: s.edges,
      budget: s.budget,
      nextNodeSeq: s.nextNodeSeq,
      nextEdgeSeq: s.nextEdgeSeq,
    };
    set((state) => ({
      past: [...state.past.slice(-(MAX_HISTORY - 1)), entry],
      future: [],
    }));
  },
  undo: () => {
    const s = get();
    if (s.past.length === 0) return;
    const prev = s.past[s.past.length - 1];
    const currentEntry: HistoryEntry = {
      nodes: s.nodes,
      edges: s.edges,
      budget: s.budget,
      nextNodeSeq: s.nextNodeSeq,
      nextEdgeSeq: s.nextEdgeSeq,
    };
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      nodesById: new Map(prev.nodes.map((n) => [n.id, n])),
      edgesById: new Map(prev.edges.map((e) => [e.id, e])),
      budget: prev.budget,
      nextNodeSeq: prev.nextNodeSeq,
      nextEdgeSeq: prev.nextEdgeSeq,
      past: s.past.slice(0, -1),
      future: [...s.future, currentEntry],
      selection: null,
      drawFromNodeId: null,
    });
  },
  redo: () => {
    const s = get();
    if (s.future.length === 0) return;
    const next = s.future[s.future.length - 1];
    const currentEntry: HistoryEntry = {
      nodes: s.nodes,
      edges: s.edges,
      budget: s.budget,
      nextNodeSeq: s.nextNodeSeq,
      nextEdgeSeq: s.nextEdgeSeq,
    };
    set({
      nodes: next.nodes,
      edges: next.edges,
      nodesById: new Map(next.nodes.map((n) => [n.id, n])),
      edgesById: new Map(next.edges.map((e) => [e.id, e])),
      budget: next.budget,
      nextNodeSeq: next.nextNodeSeq,
      nextEdgeSeq: next.nextEdgeSeq,
      past: [...s.past, currentEntry],
      future: s.future.slice(0, -1),
      selection: null,
      drawFromNodeId: null,
    });
  },

  setMode: (mode) =>
    set((s) => ({
      mode,
      drawFromNodeId: null,
      // Build tools don't exist while traffic runs (or in a locked city); keep a manager tool, else land on the selector.
      tool:
        mode === "simulate"
          ? MANAGER_TOOLS.includes(s.tool)
            ? s.tool
            : "inspect"
          : s.buildLocked
            ? s.tool
            : "draw",
      selection: null,
      rideAlongActive: mode === "simulate" ? s.rideAlongActive : false,
    })),
  setTool: (tool) =>
    set((s) => (s.buildLocked && !MANAGER_TOOLS.includes(tool) ? s : { tool, drawFromNodeId: null, selection: null })),
  setRoadClass: (id) => set({ selectedRoadClassId: id }),
  setElevation: (id) => set({ selectedElevationId: id }),
  setTwoWay: (v) => set({ twoWay: v }),
  setSelection: (s) => set({ selection: s }),

  startDrawChain: (nodeId) => set({ drawFromNodeId: nodeId }),
  cancelDrawChain: () => set({ drawFromNodeId: null }),

  createNodeAt: (position) => {
    get().pushHistoryEntry();
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

    const targetPosition = toNodeId ? state.nodesById.get(toNodeId)!.position : toPosition;
    const roadClass = ROAD_CLASSES[state.selectedRoadClassId];

    // Check clearance against the *existing* network before touching any
    // state — a rejected road shouldn't leave a dangling orphan node behind.
    const candidateNodeId = toNodeId ?? "__candidate__";
    const candidateForwardId = "__candidate_fwd__";
    const candidateBackwardId = "__candidate_bwd__";
    const candidateNodes: NodeSpec[] = toNodeId
      ? state.nodes
      : [...state.nodes, { id: candidateNodeId, position: toPosition }];
    const candidateEdges: EdgeSpec[] = [
      ...state.edges,
      {
        id: candidateForwardId,
        fromNodeId,
        toNodeId: candidateNodeId,
        interiorPoints: [],
        roadClassId: state.selectedRoadClassId,
        elevationLevelId: state.selectedElevationId,
        lanes: roadClass.lanesPerDirection,
        laneWidthFt: roadClass.laneWidthFt,
        speedLimitMph: roadClass.speedLimitMph,
      },
      ...(state.twoWay
        ? [
            {
              id: candidateBackwardId,
              fromNodeId: candidateNodeId,
              toNodeId: fromNodeId,
              interiorPoints: [],
              roadClassId: state.selectedRoadClassId,
              elevationLevelId: state.selectedElevationId,
              lanes: roadClass.lanesPerDirection,
              laneWidthFt: roadClass.laneWidthFt,
              speedLimitMph: roadClass.speedLimitMph,
            } satisfies EdgeSpec,
          ]
        : []),
    ];
    const candidateNetwork = assembleNetwork({ nodes: candidateNodes, edges: candidateEdges });
    const newViolation = findClearanceViolations(candidateNetwork).find(
      (v) => v.edgeAId === candidateForwardId || v.edgeBId === candidateForwardId
    );
    if (newViolation) {
      get().setBuildWarning(
        `Blocked: only ${newViolation.clearanceFt.toFixed(1)} ft clearance over the road below — needs 16.5 ft.`
      );
      return fromNodeId;
    }

    let targetNodeId: string;
    if (toNodeId) {
      get().pushHistoryEntry();
      targetNodeId = toNodeId;
    } else {
      targetNodeId = state.createNodeAt(toPosition);
    }
    const targetNode = get().nodesById.get(targetNodeId)!;

    const lengthFt = edgeLengthFt(fromNode.position, targetNode.position, []);
    const cost = estimateEdgeCost(
      state.selectedRoadClassId,
      state.selectedElevationId,
      lengthFt,
      roadClass.lanesPerDirection,
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

    playPlaceRoad();
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
    get().pushHistoryEntry();
    const node = get().nodesById.get(edge.fromNodeId);
    const toNode = get().nodesById.get(edge.toNodeId);
    const lengthFt =
      node && toNode
        ? edgeLengthFt(node.position, toNode.position, edge.interiorPoints)
        : 0;
    const cost = estimateEdgeCost(
      edge.roadClassId,
      edge.elevationLevelId,
      lengthFt,
      edge.lanes,
    );
    set((s) => {
      const edges = s.edges.filter((e) => e.id !== edgeId);
      const edgesById = new Map(s.edgesById);
      edgesById.delete(edgeId);
      return {
        edges,
        edgesById,
        budget: s.budget + cost * DEMOLISH_REFUND_FRACTION,
      };
    });
    playDemolish();
  },

  deleteNode: (nodeId) => {
    const connected = get().edges.filter(
      (e) => e.fromNodeId === nodeId || e.toNodeId === nodeId,
    );
    if (connected.length === 0) get().pushHistoryEntry();
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
    get().pushHistoryEntry();
    const node = get().nodesById.get(edge.fromNodeId);
    const toNode = get().nodesById.get(edge.toNodeId);
    const lengthFt =
      node && toNode
        ? edgeLengthFt(node.position, toNode.position, edge.interiorPoints)
        : 0;
    const oldCost = estimateEdgeCost(
      edge.roadClassId,
      edge.elevationLevelId,
      lengthFt,
      edge.lanes,
    );
    const newCost = estimateEdgeCost(
      edge.roadClassId,
      edge.elevationLevelId,
      lengthFt,
      clamped,
    );
    // Lane arrows are per lane, so they no longer line up once the count changes.
    const updated: EdgeSpec = { ...edge, lanes: clamped, laneMoves: undefined };
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
      get().pushHistoryEntry();
      const node = state.nodesById.get(edge.fromNodeId);
      const toNode = state.nodesById.get(edge.toNodeId);
      const lengthFt =
        node && toNode
          ? edgeLengthFt(node.position, toNode.position, edge.interiorPoints)
          : 0;
      const cost = estimateEdgeCost(
        edge.roadClassId,
        edge.elevationLevelId,
        lengthFt,
        edge.lanes,
      );
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
        return {
          edges,
          edgesById,
          nextEdgeSeq: s.nextEdgeSeq + 1,
          budget: s.budget - cost,
        };
      });
    }
  },

  setEdgeRoadClass: (edgeId, roadClassId) => {
    const edge = get().edgesById.get(edgeId);
    if (!edge) return;
    get().pushHistoryEntry();
    const node = get().nodesById.get(edge.fromNodeId);
    const toNode = get().nodesById.get(edge.toNodeId);
    const lengthFt =
      node && toNode
        ? edgeLengthFt(node.position, toNode.position, edge.interiorPoints)
        : 0;
    const oldCost = estimateEdgeCost(
      edge.roadClassId,
      edge.elevationLevelId,
      lengthFt,
      edge.lanes,
    );
    const cls = ROAD_CLASSES[roadClassId];
    const newCost = estimateEdgeCost(
      roadClassId,
      edge.elevationLevelId,
      lengthFt,
      cls.lanesPerDirection,
    );
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
    get().pushHistoryEntry();
    let zone: ZoneSpec | undefined;
    if (!edge.zone) zone = { type: "entry", demandVehPerHour: 600 };
    else if (edge.zone.type === "entry")
      zone = { type: "destination", targetSpeedMph: 25 };
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
    const updated: EdgeSpec = {
      ...edge,
      zone: { type: "entry", demandVehPerHour: vehiclesPerHour },
    };
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
    const updated: EdgeSpec = {
      ...edge,
      zone: { type: "destination", targetSpeedMph },
    };
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
    get().pushHistoryEntry();
    let resolvedControl = control;
    if (control?.type === "signal") {
      const { groupA, groupB } = computeSignalPhaseGroups(
        nodeId,
        state.edges,
        state.nodesById,
      );
      resolvedControl = {
        type: "signal",
        groupA,
        groupB,
        greenDurationS: 20,
        allRedDurationS: 2,
      };
    }
    const updated: NodeSpec = { ...node, control: resolvedControl };
    set((s) => {
      const nodes = s.nodes.map((n) => (n.id === nodeId ? updated : n));
      const nodesById = new Map(s.nodesById);
      nodesById.set(nodeId, updated);
      return { nodes, nodesById };
    });
  },

  setSignalTiming: (nodeId, greenDurationS) => {
    const node = get().nodesById.get(nodeId);
    if (!node || node.control?.type !== "signal") return;
    const green = Math.max(5, Math.min(90, Math.round(greenDurationS)));
    if (green === node.control.greenDurationS) return;
    get().pushHistoryEntry();
    const updated: NodeSpec = { ...node, control: { ...node.control, greenDurationS: green } };
    set((s) => {
      const nodes = s.nodes.map((n) => (n.id === nodeId ? updated : n));
      const nodesById = new Map(s.nodesById);
      nodesById.set(nodeId, updated);
      return { nodes, nodesById };
    });
  },

  setSignalOffset: (nodeId, offsetS) => {
    const node = get().nodesById.get(nodeId);
    if (!node || node.control?.type !== "signal") return;
    const cycle = 2 * (node.control.greenDurationS + node.control.allRedDurationS);
    const offset = Math.max(0, Math.min(cycle - 1, Math.round(offsetS)));
    if (offset === (node.control.offsetS ?? 0)) return;
    get().pushHistoryEntry();
    const updated: NodeSpec = { ...node, control: { ...node.control, offsetS: offset } };
    set((s) => {
      const nodes = s.nodes.map((n) => (n.id === nodeId ? updated : n));
      const nodesById = new Map(s.nodesById);
      nodesById.set(nodeId, updated);
      return { nodes, nodesById };
    });
  },

  setLaneMoves: (edgeId, laneIndex, moves) => {
    const state = get();
    const edge = state.edgesById.get(edgeId);
    if (!edge || moves.length === 0 || laneIndex < 0 || laneIndex >= edge.lanes) return;
    const assembled = assembleCached(state.nodes, state.edges).edgesById.get(edgeId);
    if (!assembled) return;
    // Start from what's in effect now (manual or automatic) so editing one lane doesn't disturb the rest.
    const next = assembled.laneMoves.map((m, i) => (i === laneIndex ? moves : [...m]));
    get().pushHistoryEntry();
    const updated: EdgeSpec = { ...edge, laneMoves: next };
    set((s) => {
      const edges = s.edges.map((e) => (e.id === edgeId ? updated : e));
      const edgesById = new Map(s.edgesById);
      edgesById.set(edgeId, updated);
      return { edges, edgesById };
    });
  },

  resetLaneMoves: (edgeId) => {
    const edge = get().edgesById.get(edgeId);
    if (!edge?.laneMoves) return;
    get().pushHistoryEntry();
    const updated: EdgeSpec = { ...edge, laneMoves: undefined };
    set((s) => {
      const edges = s.edges.map((e) => (e.id === edgeId ? updated : e));
      const edgesById = new Map(s.edgesById);
      edgesById.set(edgeId, updated);
      return { edges, edgesById };
    });
  },

  setSpeedLimit: (edgeId, mph, wholeRoad) => {
    const state = get();
    const targets = collectRoadTargets(state, edgeId, wholeRoad);
    if (targets.size === 0) return;
    const changed = state.edges.filter((e) => targets.has(e.id) && e.speedLimitMph !== mph);
    if (changed.length === 0) return;
    get().pushHistoryEntry();
    set((s) => {
      const edges = s.edges.map((e) => (targets.has(e.id) ? { ...e, speedLimitMph: mph } : e));
      return { edges, edgesById: new Map(edges.map((e) => [e.id, e])) };
    });
  },

  setRoadOneWay: (edgeId, oneWay, wholeRoad) => {
    const state = get();
    const chain = collectRoadTargets(state, edgeId, wholeRoad, false);
    if (chain.size === 0) return;

    if (oneWay) {
      const remove = new Set<string>();
      for (const id of chain) {
        const counter = findCounterpart(state.edges, state.edgesById.get(id)!);
        if (counter && !chain.has(counter.id)) remove.add(counter.id);
      }
      if (remove.size === 0) {
        pushToast("That road only goes one way already", "info");
        return;
      }
      if ([...remove].some((id) => state.edgesById.get(id)?.zone)) {
        pushToast("An entry or exit is on the other side, so that direction has to stay open", "alert");
        return;
      }
      const edges = state.edges.filter((e) => !remove.has(e.id));
      const nodes = refreshSignals(state.nodes, edges);
      if (!trafficStaysConnected({ nodes, edges })) {
        pushToast("One-way would cut some traffic off from where it's headed", "alert");
        return;
      }
      get().pushHistoryEntry();
      set({ nodes, edges, nodesById: new Map(nodes.map((n) => [n.id, n])), edgesById: new Map(edges.map((e) => [e.id, e])), selection: null });
      return;
    }

    // Back to two-way: add the missing opposite carriageway of each segment.
    const added: EdgeSpec[] = [];
    let seq = state.nextEdgeSeq;
    let cost = 0;
    for (const id of chain) {
      const e = state.edgesById.get(id)!;
      if (findCounterpart(state.edges, e)) continue;
      const from = state.nodesById.get(e.fromNodeId);
      const to = state.nodesById.get(e.toNodeId);
      if (from && to && !state.buildLocked) {
        cost += estimateEdgeCost(e.roadClassId, e.elevationLevelId, edgeLengthFt(from.position, to.position, e.interiorPoints), e.lanes);
      }
      const back: EdgeSpec = {
        id: `e${seq++}`,
        fromNodeId: e.toNodeId,
        toNodeId: e.fromNodeId,
        interiorPoints: reversePoints(e.interiorPoints),
        roadClassId: e.roadClassId,
        elevationLevelId: e.elevationLevelId,
        lanes: e.lanes,
        laneWidthFt: e.laneWidthFt,
        speedLimitMph: e.speedLimitMph,
      };
      if (e.reservedLane) back.reservedLane = e.reservedLane;
      added.push(back);
    }
    if (added.length === 0) {
      pushToast("That road already goes both ways", "info");
      return;
    }
    if (!isSandboxBudget(state.budget) && cost > state.budget) {
      pushToast("Not enough budget to add the opposite lanes", "alert");
      return;
    }
    get().pushHistoryEntry();
    const edges = [...state.edges, ...added];
    const nodes = refreshSignals(state.nodes, edges);
    set((s) => ({
      nodes,
      edges,
      nodesById: new Map(nodes.map((n) => [n.id, n])),
      edgesById: new Map(edges.map((e) => [e.id, e])),
      nextEdgeSeq: seq,
      budget: isSandboxBudget(s.budget) ? s.budget : s.budget - cost,
      selection: null,
    }));
  },

  setBusStop: (edgeId, on) => {
    const state = get();
    const edge = state.edgesById.get(edgeId);
    if (!edge || edge.isRoundaboutRing || !!edge.busStop === on) return;
    const from = state.nodesById.get(edge.fromNodeId);
    const to = state.nodesById.get(edge.toNodeId);
    if (!from || !to) return;
    if (on && edgeLengthFt(from.position, to.position, edge.interiorPoints) < MIN_BUS_STOP_ROAD_FT) {
      pushToast("That stretch is too short for a stop, so try a longer block", "alert");
      return;
    }
    get().pushHistoryEntry();
    set((s) => {
      const edges = s.edges.map((e) => {
        if (e.id !== edgeId) return e;
        const next = { ...e };
        if (on) next.busStop = true;
        else delete next.busStop;
        return next;
      });
      return { edges, edgesById: new Map(edges.map((e) => [e.id, e])) };
    });
  },

  setParking: (edgeId, on, wholeRoad) => {
    const state = get();
    const targets = collectRoadTargets(state, edgeId, wholeRoad);
    const changed = state.edges.filter(
      (e) => targets.has(e.id) && !e.isRoundaboutRing && (e.roadClassId === "lane" || e.roadClassId === "street" || e.roadClassId === "avenue") && !!e.parking !== on,
    );
    if (changed.length === 0) {
      if (on) pushToast("Parking only fits on lanes, streets and avenues", "info");
      return;
    }
    get().pushHistoryEntry();
    const ids = new Set(changed.map((e) => e.id));
    set((s) => {
      const edges = s.edges.map((e) => {
        if (!ids.has(e.id)) return e;
        const next = { ...e };
        if (on) next.parking = true;
        else delete next.parking;
        return next;
      });
      return { edges, edgesById: new Map(edges.map((e) => [e.id, e])) };
    });
  },

  setCrosswalk: (edgeId, on) => {
    const state = get();
    const edge = state.edgesById.get(edgeId);
    if (!edge || edge.isRoundaboutRing) return;
    const from = state.nodesById.get(edge.fromNodeId);
    const to = state.nodesById.get(edge.toNodeId);
    if (!from || !to) return;
    if (on && edgeLengthFt(from.position, to.position, edge.interiorPoints) < MIN_CROSSWALK_ROAD_FT) {
      pushToast("That stretch is too short for a crossing, so try a longer block", "alert");
      return;
    }
    const ids = new Set([edgeId]);
    const back = findCounterpart(state.edges, edge);
    if (back) ids.add(back.id);
    if (state.edges.every((e) => !ids.has(e.id) || !!e.crosswalk === on)) return;
    get().pushHistoryEntry();
    set((s) => {
      const edges = s.edges.map((e) => {
        if (!ids.has(e.id)) return e;
        const next = { ...e };
        if (on) next.crosswalk = true;
        else delete next.crosswalk;
        return next;
      });
      return { edges, edgesById: new Map(edges.map((e) => [e.id, e])) };
    });
  },

  setReservedLane: (edgeId, kind, wholeRoad) => {
    const state = get();
    const targets = collectRoadTargets(state, edgeId, wholeRoad);
    // Only roads with a lane to spare can give one up; a single-lane road keeps serving everyone.
    const changed = state.edges.filter(
      (e) => targets.has(e.id) && e.lanes >= 2 && !e.isRoundaboutRing && (e.reservedLane ?? null) !== kind,
    );
    if (changed.length === 0) return;
    get().pushHistoryEntry();
    const ids = new Set(changed.map((e) => e.id));
    set((s) => {
      const edges = s.edges.map((e) => {
        if (!ids.has(e.id)) return e;
        const next = { ...e };
        if (kind) next.reservedLane = kind;
        else delete next.reservedLane;
        return next;
      });
      return { edges, edgesById: new Map(edges.map((e) => [e.id, e])) };
    });
  },

  convertNodeToRoundabout: (nodeId, radiusFt) => {
    const state = get();
    const node = state.nodesById.get(nodeId);
    if (!node) return;

    const connected = state.edges.filter(
      (e) => e.fromNodeId === nodeId || e.toNodeId === nodeId,
    );
    if (connected.length === 0) return;
    get().pushHistoryEntry();

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
      return Math.atan2(
        other.position[2] - node.position[2],
        other.position[0] - node.position[0],
      );
    };

    const legs = Array.from(legMap.entries())
      .map(([otherId, legEdges]) => ({
        otherId,
        angle: angleOf(otherId),
        edges: legEdges,
      }))
      .sort((a, b) => a.angle - b.angle);

    const radius = radiusFt ?? Math.max(45, legs.length * 16);
    const y = node.position[1];
    // The ring's own capacity shouldn't be a hard single-lane bottleneck
    // regardless of how busy the roads feeding it are — scale it with the
    // widest connected approach (capped at 2, since a roundabout wider than
    // that starts fighting the simulation's generic lane-changing logic,
    // which isn't roundabout-aware).
    const maxApproachLanes = Math.max(1, ...connected.map((e) => e.lanes));
    const ringLanes = Math.max(1, Math.min(2, maxApproachLanes));

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
        if (e.toNodeId === nodeId)
          repointedById.set(e.id, { ...e, toNodeId: ringNodeId });
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
      const delta =
        (((legs[(i + 1) % legs.length].angle - a.angle) % (Math.PI * 2)) +
          Math.PI * 2) %
        (Math.PI * 2);
      // Several points along the true arc (not one bowed midpoint), so the ring is round with no corner at each leg.
      const arcPoints: [number, number, number][] = [];
      const ARC_STEPS = 4;
      for (let k = 1; k < ARC_STEPS; k++) {
        const ang = a.angle + (delta * k) / ARC_STEPS;
        arcPoints.push([node.position[0] + Math.cos(ang) * radius, y, node.position[2] + Math.sin(ang) * radius]);
      }
      const length = edgeLengthFt(fromNode.position, toNode.position, arcPoints);
      ringCost += estimateEdgeCost("lane", "ground", length, ringLanes);
      ringEdges.push({
        id: `e${edgeSeq++}`,
        fromNodeId: fromNode.id,
        toNodeId: toNode.id,
        interiorPoints: arcPoints,
        roadClassId: "lane",
        elevationLevelId: "ground",
        lanes: ringLanes,
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

  createTexasTurnaround: (edgeId, clickPoint) => {
    const state = get();
    const network = assembleNetworkCached(state.nodes, state.edges);
    const plan = planTexasTurnaround(network, edgeId, new THREE.Vector3(...clickPoint));

    if (!plan) {
      get().setBuildWarning(
        `No opposing frontage road found within ${TEXAS_TURNAROUND_SEARCH_RADIUS_FT} ft — build one running the opposite direction nearby.`
      );
      return;
    }

    const nodeAId = get().splitEdgeAt(edgeId, plan.nodeAPoint);
    const nodeBId = get().splitEdgeAt(plan.targetEdgeId, plan.nodeBPoint);

    const interiorPoints = [plan.controlPoint1, plan.controlPoint2];
    const cost = Math.round(ROAD_CLASSES.lane.costPerFtPerLane * plan.lengthFt * TEXAS_TURNAROUND_COST_MULTIPLIER);

    const turnaroundEdge: EdgeSpec = {
      id: `e${get().nextEdgeSeq}`,
      fromNodeId: nodeAId,
      toNodeId: nodeBId,
      interiorPoints,
      roadClassId: "lane",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: TEXAS_TURNAROUND_LANE_WIDTH_FT,
      speedLimitMph: TEXAS_TURNAROUND_SPEED_MPH,
      isTexasTurnaround: true,
    };

    set((s) => {
      const edges = [...s.edges, turnaroundEdge];
      const edgesById = new Map(s.edgesById);
      edgesById.set(turnaroundEdge.id, turnaroundEdge);
      return {
        edges,
        edgesById,
        nextEdgeSeq: s.nextEdgeSeq + 1,
        budget: s.budget - cost,
        selection: null,
      };
    });

    playPlaceRoad();
  },

  clearNetwork: () => {
    get().pushHistoryEntry();
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
    });
  },

  getSnapshot: () => {
    const s = get();
    return { nodes: s.nodes, edges: s.edges } satisfies NetworkSnapshot;
  },

  exportPayload: () => {
    const s = get();
    return {
      version: 1,
      network: { nodes: s.nodes, edges: s.edges },
      budget: s.budget,
      nextNodeSeq: s.nextNodeSeq,
      nextEdgeSeq: s.nextEdgeSeq,
    };
  },

  importPayload: (payload) => {
    get().pushHistoryEntry();
    set({
      nodes: payload.network.nodes,
      edges: payload.network.edges,
      nodesById: new Map(payload.network.nodes.map((n) => [n.id, n])),
      edgesById: new Map(payload.network.edges.map((e) => [e.id, e])),
      budget: payload.budget,
      nextNodeSeq: payload.nextNodeSeq,
      nextEdgeSeq: payload.nextEdgeSeq,
      selection: null,
      drawFromNodeId: null,
    });
  },

  hydrateAutosave: () => {
    const payload = loadAutosave();
    if (!payload) return;
    // No history entry pushed (unlike importPayload) — this is the very
    // first thing to touch the network after mount, so there's no prior
    // state worth making undoable back to.
    set({
      nodes: payload.network.nodes,
      edges: payload.network.edges,
      nodesById: new Map(payload.network.nodes.map((n) => [n.id, n])),
      edgesById: new Map(payload.network.edges.map((e) => [e.id, e])),
      budget: payload.budget,
      nextNodeSeq: payload.nextNodeSeq,
      nextEdgeSeq: payload.nextEdgeSeq,
    });
  },

  activeScenarioId: null,
  buildLocked: false,
  realCityActive: false,
  economyK: FREE_BUILD_ECONOMY_K,
  applyEconomy: (deltaS) => {
    const s = get();
    if (s.economyK === null || isSandboxBudget(s.budget) || deltaS <= 0) return;
    const { upkeep, income } = economyRates(s.nodes, s.edges, s.economyK);
    const net = (income - upkeep) * deltaS;
    if (net !== 0) set({ budget: s.budget + net });
  },
  placeName: null,
  startPlace: (network, name) =>
    set((s) => ({
      nodes: network.nodes,
      edges: network.edges,
      nodesById: new Map(network.nodes.map((n) => [n.id, n])),
      edgesById: new Map(network.edges.map((e) => [e.id, e])),
      budget: SANDBOX_BUDGET,
      nextNodeSeq: 1,
      nextEdgeSeq: 1,
      selection: null,
      drawFromNodeId: null,
      mode: "build",
      tool: "inspect",
      buildLocked: false,
      realCityActive: true,
      activeScenarioId: null,
      trafficMix: MIXED_MIX,
      weather: "clear",
      dayCycle: false,
      placeName: name,
      economyK: null,
      simEpoch: s.simEpoch + 1,
      pendingCameraFit: {
        centerX: 0,
        centerZ: 0,
        radiusFt: 1.2 * network.nodes.reduce((r, n) => Math.max(r, Math.abs(n.position[0]), Math.abs(n.position[2])), 0),
      },
      past: [],
      future: [],
    })),
  weather: "clear",
  setWeather: (w) => set({ weather: w }),
  dayCycle: false,
  setDayCycle: (on) => set({ dayCycle: on }),
  trafficMix: CLASSIC_MIX,
  setTrafficMix: (mix) => set({ trafficMix: mix }),
  simEpoch: 0,

  loadScenario: (scenario) => {
    set({
      nodes: scenario.startingNetwork.nodes,
      edges: scenario.startingNetwork.edges,
      nodesById: new Map(scenario.startingNetwork.nodes.map((n) => [n.id, n])),
      edgesById: new Map(scenario.startingNetwork.edges.map((e) => [e.id, e])),
      budget: scenario.startingBudget,
      nextNodeSeq: 1,
      nextEdgeSeq: 1,
      selection: null,
      drawFromNodeId: null,
      // Manage cities open straight to traffic — the point is to watch it break and fix it live.
      mode: scenario.kind === "manage" ? "simulate" : "build",
      tool: scenario.kind === "manage" ? "inspect" : get().tool,
      buildLocked: scenario.kind === "manage",
      realCityActive: scenario.real === true,
      placeName: null,
      economyK:
        scenario.kind === "manage"
          ? null
          : economyKFor(scenario.startingNetwork.nodes, scenario.startingNetwork.edges, scenario.startingBudget, scenario.durationS),
      trafficMix: scenario.trafficMix ?? CLASSIC_MIX,
      weather: "clear",
      dayCycle: false,
      simEpoch: get().simEpoch + 1,
      // Frame the whole city: zoom out to the farthest node.
      pendingCameraFit: {
        centerX: 0,
        centerZ: 0,
        // The farthest node along either axis (not the diagonal): the camera adds its own margin for the oblique view.
        radiusFt:
          1.2 * scenario.startingNetwork.nodes.reduce((r, n) => Math.max(r, Math.abs(n.position[0]), Math.abs(n.position[2])), 0),
      },
      activeScenarioId: scenario.id,
      past: [],
      future: [],
    });
  },

  exitScenario: () => set({ activeScenarioId: null, buildLocked: false, realCityActive: false, placeName: null, economyK: FREE_BUILD_ECONOMY_K, trafficMix: CLASSIC_MIX }),
  enterSandboxMode: () => set({ activeScenarioId: null, buildLocked: false, realCityActive: false, economyK: null, budget: SANDBOX_BUDGET }),
  startSandbox: () => {
    get().clearNetwork();
    set({
      activeScenarioId: null,
      buildLocked: false,
      realCityActive: false,
      placeName: null,
      economyK: null,
      trafficMix: MIXED_MIX,
      budget: SANDBOX_BUDGET,
      mode: "build",
      tool: "draw",
      selection: null,
      drawFromNodeId: null,
      pendingCameraFit: { centerX: 0, centerZ: 0 },
    });
  },
}));

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
useEditorStore.subscribe((state) => {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    saveAutosave({
      version: 1,
      network: { nodes: state.nodes, edges: state.edges },
      budget: state.budget,
      nextNodeSeq: state.nextNodeSeq,
      nextEdgeSeq: state.nextEdgeSeq,
    });
  }, 600);
});
