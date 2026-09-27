import { ROAD_CLASSES, type RoadClassId } from "./roadClasses";

/** Level of Service grade, A (free-flow) through F (breakdown/gridlock), graded on the v/c ratio. */
export type LOSGrade = "A" | "B" | "C" | "D" | "E" | "F";

/** Live traffic performance stats for a single edge, computed once per tick in the worker. */
export interface EdgeTrafficStats {
  edgeId: string;
  /** Vehicles currently on the edge. */
  vehicleCount: number;
  /** veh / mile / lane. */
  densityPerLane: number;
  /** Average vehicle speed on this edge, mph. */
  avgSpeedMph: number;
  /** veh/h/lane, derived from the fundamental flow relation (flow = density x speed). */
  flowPerLaneVehPerHour: number;
  /** flowPerLaneVehPerHour / this class's per-lane capacity. */
  vcRatio: number;
  los: LOSGrade;
}

/** HCM-style v/c breakpoints — the same scale regardless of road class, since class differences are already priced into capacity. */
export function losFromVcRatio(vcRatio: number): LOSGrade {
  if (vcRatio <= 0.2) return "A";
  if (vcRatio <= 0.4) return "B";
  if (vcRatio <= 0.6) return "C";
  if (vcRatio <= 0.8) return "D";
  if (vcRatio <= 1.0) return "E";
  return "F";
}

export const LOS_DESCRIPTIONS: Record<LOSGrade, string> = {
  A: "Free flow",
  B: "Reasonably free flow",
  C: "Stable flow",
  D: "Approaching unstable",
  E: "At capacity",
  F: "Breakdown / gridlock",
};

/** Roughly matches the sticker-book palette: blue for good, amber for marginal, red for bad. */
export const LOS_COLOR: Record<LOSGrade, string> = {
  A: "#3b82f6",
  B: "#38bdf8",
  C: "#eab308",
  D: "#f59e0b",
  E: "#f97316",
  F: "#ef4444",
};

/**
 * Computes live LOS/v-c/flow stats for one edge.
 * @param vehicleCount vehicles currently on the edge
 * @param avgSpeedMph average speed of those vehicles
 * @param lengthFt edge centerline length
 * @param lanes lanes in this direction
 * @param roadClassId used to look up per-lane capacity
 */
export function computeEdgeTrafficStats(
  edgeId: string,
  vehicleCount: number,
  avgSpeedMph: number,
  lengthFt: number,
  lanes: number,
  roadClassId: RoadClassId
): EdgeTrafficStats {
  const lengthMiles = Math.max(lengthFt / 5280, 1e-6);
  const densityPerLane = vehicleCount / lanes / lengthMiles;
  // Fundamental traffic-flow relation: flow (veh/h) = density (veh/mi) x speed (mi/h).
  const flowPerLaneVehPerHour = densityPerLane * avgSpeedMph;
  const capacity = ROAD_CLASSES[roadClassId].capacityVehPerHourPerLane;
  const vcRatio = flowPerLaneVehPerHour / capacity;
  return {
    edgeId,
    vehicleCount,
    densityPerLane,
    avgSpeedMph,
    flowPerLaneVehPerHour,
    vcRatio,
    los: losFromVcRatio(vcRatio),
  };
}
