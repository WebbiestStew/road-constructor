import * as THREE from "three";

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

/** A junction / control point in the road graph, in feet (x, y-up, z). */
export interface Node3D {
  id: string;
  /** [x, y, z] in feet. y is elevation (up). */
  position: [number, number, number];
}

export type EdgeKind = "mainline" | "ramp" | "turnaround" | "overpass";

/**
 * A directed road segment connecting two nodes. The centerline is a
 * Catmull-Rom spline built from the node positions plus any interior
 * shaping control points. Lanes are indexed left-to-right (0 = leftmost)
 * across the segment, all traveling the same direction (one-way).
 */
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
  kind: EdgeKind;
  /** IDs of edges that this edge may transition into at its terminal node. */
  nextEdgeIds: string[];
  /** True if any sampled point along this edge has elevation > 1 ft. */
  isElevated: boolean;
}

export interface RouteDef {
  id: string;
  /** Ordered edge IDs a vehicle following this route will traverse. */
  edgeIds: string[];
  /** Relative spawn probability weight among routes sharing an entry. */
  weight: number;
}

export interface EntryPointDef {
  id: string;
  label: string;
  edgeId: string;
  /** Lane index on edgeId that spawned vehicles enter on. */
  laneIndex: number;
  routes: RouteDef[];
}

export interface RoadNetwork {
  nodes: Node3D[];
  edges: Edge3D[];
  edgesById: Map<string, Edge3D>;
  entries: EntryPointDef[];
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
  /** Route this vehicle is following, and its index into edgeIds. */
  routeEdgeIds: string[];
  routeIndex: number;
  /** Ticks until this vehicle is allowed to re-evaluate a lane change. */
  laneChangeCooldown: number;
  /** Distance already accumulated toward the current lap (for despawn / metrics). */
  totalDistanceFt: number;
  spawnTime: number;
}

/** Message protocol: main thread -> worker. */
export type WorkerInMessage =
  | { type: "setRunning"; running: boolean }
  | { type: "setSpeedMultiplier"; value: number }
  | { type: "setDemand"; entryId: string; vehiclesPerHour: number }
  | {
      type: "returnBuffers";
      matrices: ArrayBuffer;
      colors: ArrayBuffer;
    };

/** Message protocol: worker -> main thread. */
export type WorkerOutMessage =
  | {
      type: "ready";
      entries: { id: string; label: string }[];
    }
  | {
      type: "tick";
      matrices: ArrayBuffer;
      colors: ArrayBuffer;
      activeCount: number;
      simTime: number;
      avgSpeedFtS: number;
      throughputLastMinute: number;
      spawnedTotal: number;
    };

export interface SimMetrics {
  activeCount: number;
  avgSpeedMph: number;
  throughputPerMinute: number;
  simTime: number;
}
