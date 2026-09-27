/**
 * Road class + elevation catalogs. These are the "palette" the road editor
 * offers, and the source of truth for default lanes/speed/width and for
 * construction cost estimation.
 */

export type RoadClassId = "lane" | "street" | "avenue" | "highway" | "motorway";

export interface RoadClassDef {
  id: RoadClassId;
  label: string;
  description: string;
  lanesPerDirection: number;
  laneWidthFt: number;
  speedLimitMph: number;
  /** Right-of-way ranking at unsignalized junctions; higher yields less. */
  priority: number;
  /** Construction cost, $ per linear foot per lane, at grade. */
  costPerFtPerLane: number;
  /** Whether a two-way road of this class gets a painted/physical median gap. */
  divided: boolean;
  medianGapFt: number;
  /** Theoretical capacity, vehicles/hour/lane, used for the v/c ratio and Level of Service grade. */
  capacityVehPerHourPerLane: number;
  /** Estimated maintenance cost, $ per linear foot per lane per hour of operation. */
  upkeepPerFtPerLanePerHour: number;
}

export const ROAD_CLASSES: Record<RoadClassId, RoadClassDef> = {
  lane: {
    id: "lane",
    label: "Country Lane",
    description: "Single lane each way. Cheap, low speed.",
    lanesPerDirection: 1,
    laneWidthFt: 10,
    speedLimitMph: 35,
    priority: 1,
    costPerFtPerLane: 40,
    divided: false,
    medianGapFt: 0,
    capacityVehPerHourPerLane: 900,
    upkeepPerFtPerLanePerHour: 0.002,
  },
  street: {
    id: "street",
    label: "Street",
    description: "Single lane each way, urban.",
    lanesPerDirection: 1,
    laneWidthFt: 11,
    speedLimitMph: 30,
    priority: 2,
    costPerFtPerLane: 60,
    divided: false,
    medianGapFt: 0,
    capacityVehPerHourPerLane: 1000,
    upkeepPerFtPerLanePerHour: 0.003,
  },
  avenue: {
    id: "avenue",
    label: "Avenue",
    description: "Two lanes each way, undivided.",
    lanesPerDirection: 2,
    laneWidthFt: 11,
    speedLimitMph: 40,
    priority: 3,
    costPerFtPerLane: 85,
    divided: false,
    medianGapFt: 0,
    capacityVehPerHourPerLane: 1400,
    upkeepPerFtPerLanePerHour: 0.005,
  },
  highway: {
    id: "highway",
    label: "Highway",
    description: "Two lanes each way, divided median.",
    lanesPerDirection: 2,
    laneWidthFt: 12,
    speedLimitMph: 55,
    priority: 4,
    costPerFtPerLane: 140,
    divided: true,
    medianGapFt: 12,
    capacityVehPerHourPerLane: 2000,
    upkeepPerFtPerLanePerHour: 0.008,
  },
  motorway: {
    id: "motorway",
    label: "Motorway",
    description: "Three lanes each way, divided, high speed.",
    lanesPerDirection: 3,
    laneWidthFt: 12,
    speedLimitMph: 65,
    priority: 5,
    costPerFtPerLane: 190,
    divided: true,
    medianGapFt: 16,
    capacityVehPerHourPerLane: 2200,
    upkeepPerFtPerLanePerHour: 0.012,
  },
};

/** Estimated hourly maintenance cost, in dollars, for a road segment. */
export function estimateEdgeUpkeepPerHour(roadClassId: RoadClassId, lengthFt: number, lanes: number): number {
  return ROAD_CLASSES[roadClassId].upkeepPerFtPerLanePerHour * lanes * lengthFt;
}

export const ROAD_CLASS_LIST: RoadClassDef[] = [
  ROAD_CLASSES.lane,
  ROAD_CLASSES.street,
  ROAD_CLASSES.avenue,
  ROAD_CLASSES.highway,
  ROAD_CLASSES.motorway,
];

export type ElevationLevelId = "tunnel" | "cutting" | "ground" | "bridge" | "viaduct";

export interface ElevationLevelDef {
  id: ElevationLevelId;
  label: string;
  elevationFt: number;
  costMultiplier: number;
}

export const ELEVATION_LEVELS: ElevationLevelDef[] = [
  { id: "tunnel", label: "Tunnel", elevationFt: -35, costMultiplier: 4.5 },
  { id: "cutting", label: "Cutting", elevationFt: -12, costMultiplier: 1.6 },
  { id: "ground", label: "Ground", elevationFt: 0, costMultiplier: 1 },
  { id: "bridge", label: "Bridge", elevationFt: 24, costMultiplier: 2.2 },
  { id: "viaduct", label: "Viaduct", elevationFt: 42, costMultiplier: 3.2 },
];

export const ELEVATION_BY_ID: Record<ElevationLevelId, ElevationLevelDef> = {
  tunnel: ELEVATION_LEVELS[0],
  cutting: ELEVATION_LEVELS[1],
  ground: ELEVATION_LEVELS[2],
  bridge: ELEVATION_LEVELS[3],
  viaduct: ELEVATION_LEVELS[4],
};

/** Estimated construction cost, in dollars, for a road segment. */
export function estimateEdgeCost(
  roadClassId: RoadClassId,
  elevationLevelId: ElevationLevelId,
  lengthFt: number,
  lanes: number
): number {
  const cls = ROAD_CLASSES[roadClassId];
  const elevation = ELEVATION_BY_ID[elevationLevelId];
  return Math.round(cls.costPerFtPerLane * lanes * lengthFt * elevation.costMultiplier);
}

/** Refund fraction when demolishing a road segment. */
export const DEMOLISH_REFUND_FRACTION = 0.5;

/**
 * Priority rank given to roundabout ring edges — always higher than any
 * road class (max 5), so circulating traffic never yields to entering
 * traffic, matching real right-of-way rules.
 */
export const ROUNDABOUT_PRIORITY = 99;

export const ROUNDABOUT_SPEED_MPH = 20;
export const ROUNDABOUT_LANE_WIDTH_FT = 14;
