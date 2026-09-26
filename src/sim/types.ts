import * as THREE from "three";
import type { ElevationLevelId, RoadClassId } from "./roadClasses";

/**
 * Global shared constants. All spatial units are feet, speeds are ft/s
 * internally (converted to/from mph only at the UI boundary), and time is
 * seconds unless suffixed otherwise.
 */
export const FEET_PER_MILE = 5280;
export const MPH_TO_FTPS = FEET_PER_MILE / 3600;
export const FTPS_TO_MPH = 3600 / FEET_PER_MILE;

export function mphToFtps(mph: number): number {
  return mph * MPH_TO_FTPS;
}

export function ftpsToMph(ftps: number): number {
  return ftps * FTPS_TO_MPH;
}

/** Maximum number of concurrently simulated/rendered vehicles. */
export const MAX_VEHICLES = 1500;

/** Fixed simulation timestep, in seconds (30 ticks/sec). */
export const SIM_DT = 1 / 30;

/** Vehicle physical footprint, in feet. */
export const VEHICLE_LENGTH_FT = 15;
export const VEHICLE_WIDTH_FT = 6.5;
export const VEHICLE_HEIGHT_FT = 4.5;

export const DEFAULT_LANE_WIDTH_FT = 12;

// ---------------------------------------------------------------------------
// Editable network model (the "source of truth" the road editor mutates)
// ---------------------------------------------------------------------------

export interface SignalControl {
  type: "signal";
  /** Incoming edge IDs that share a green phase. */
  groupA: string[];
  groupB: string[];
  greenDurationS: number;
  allRedDurationS: number;
}

export type JunctionControl = SignalControl | { type: "priority" };

/** A junction / control point in the road graph, in feet (x, y-up, z). */
export interface NodeSpec {
  id: string;
  /** [x, y, z] in feet. y is elevation (up). */
  position: [number, number, number];
  control?: JunctionControl;
}

export type ZoneSpec =
  | { type: "entry"; demandVehPerHour: number }
  | { type: "destination"; targetSpeedMph: number };

/**
 * A directed, one-way road segment connecting two nodes. Two-way roads are
 * represented as a pair of EdgeSpecs running opposite directions between
 * the same nodes (which is also how asymmetric lane counts fall out
 * naturally — the two directions are just independently editable edges).
 */
export interface EdgeSpec {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** Interior shaping points only; endpoints are taken from the node positions. */
  interiorPoints: [number, number, number][];
  roadClassId: RoadClassId;
  elevationLevelId: ElevationLevelId;
  lanes: number;
  laneWidthFt: number;
  speedLimitMph: number;
  zone?: ZoneSpec;
}

/** The editable network as plain, structured-cloneable data. */
export interface NetworkSnapshot {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

// ---------------------------------------------------------------------------
// Assembled/runtime network (built from a NetworkSnapshot by assembleNetwork)
// ---------------------------------------------------------------------------

/** Runtime edge: an EdgeSpec plus its constructed spline and derived data. */
export interface Edge3D {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  spline: THREE.CatmullRomCurve3;
  lanes: number;
  laneWidthFt: number;
  speedLimitMph: number;
  /** Arc length of the centerline, in feet (cached from the spline). */
  length: number;
  roadClassId: RoadClassId;
  elevationLevelId: ElevationLevelId;
  /** Priority ranking copied from the road class, for junction yielding. */
  priority: number;
  /** True for highway/motorway classes (gets median + Jersey barriers). */
  isFreeway: boolean;
  /** True if any sampled point along this edge has elevation > 1 ft. */
  isElevated: boolean;
  zone?: ZoneSpec;
  /** IDs of edges that this edge may transition into at its terminal node. */
  nextEdgeIds: string[];
}

export interface RoadNetwork {
  nodesById: Map<string, NodeSpec>;
  edges: Edge3D[];
  edgesById: Map<string, Edge3D>;
}

/** Mutable per-vehicle simulation state, held only inside the worker. */
export interface VehicleState {
  id: number;
  edgeId: string;
  laneIndex: number;
  /** Distance traveled along the current edge's centerline, in feet. */
  distanceAlongEdge: number;
  /** Current speed, ft/s. */
  speed: number;
  /** Current acceleration from last IDM evaluation, ft/s^2. */
  accel: number;
  /** Desired free-flow speed for this driver, ft/s. */
  desiredSpeed: number;
  maxAccel: number;
  comfortBrake: number;
  jamDistance: number;
  desiredHeadway: number;
  minGap: number;
  length: number;
  /** Route this vehicle is following (a sequence of edge IDs), and its index into it. */
  routeEdgeIds: string[];
  routeIndex: number;
  /** Ticks until this vehicle is allowed to re-evaluate a lane change. */
  laneChangeCooldown: number;
  /** Destination edge ID this vehicle is trying to reach (for contract metrics). */
  destinationEdgeId: string;
  spawnTime: number;
}

// ---------------------------------------------------------------------------
// Worker message protocol
// ---------------------------------------------------------------------------

export type WorkerInMessage =
  | { type: "updateNetwork"; network: NetworkSnapshot; seed: number }
  | { type: "setRunning"; running: boolean }
  | { type: "setSpeedMultiplier"; value: number }
  | { type: "setDemand"; edgeId: string; vehiclesPerHour: number }
  | { type: "returnBuffers"; matrices: ArrayBuffer; colors: ArrayBuffer };

export interface ContractStatus {
  edgeId: string;
  targetSpeedMph: number;
  actualSpeedMph: number;
  sampleCount: number;
  meetsThreshold: boolean;
}

export type WorkerOutMessage =
  | { type: "ready" }
  | {
      type: "tick";
      matrices: ArrayBuffer;
      colors: ArrayBuffer;
      activeCount: number;
      simTime: number;
      avgSpeedFtS: number;
      throughputLastMinute: number;
      spawnedTotal: number;
      contracts: ContractStatus[];
    };
