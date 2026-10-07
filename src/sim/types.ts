import * as THREE from "three";
import type { ElevationLevelId, RoadClassId } from "./roadClasses";
import type { EdgeTrafficStats } from "./los";

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

/** Spacing of the samples in a JoinPad. */
export const JOIN_STEP_FT = 10;

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
  /** Seconds into the signal cycle this light starts at. Staggering neighbouring lights by their travel time makes a "green wave". Default 0. */
  offsetS?: number;
  /** How the light is phased: the classic two phases (default), a protected left-turn phase for each direction, or one phase per approach. See sim/signals. */
  mode?: "two" | "protected" | "split";
  /** Seconds of green for the protected left-turn phase. Default 8. */
  leftGreenS?: number;
  /** Seconds of an all-red pedestrian phase added to the cycle. Default 0 (none). */
  pedPhaseS?: number;
}

/** A movement a lane may make at the end of its road. U-turns count as "left". */
export type LaneMove = "left" | "straight" | "right";

export const LANE_MOVES: LaneMove[] = ["left", "straight", "right"];

/** Something that happens at an exact moment of a level's run, so every attempt faces the same trouble. */
export type ScriptedEvent =
  | { atS: number; kind: "breakdown"; durationS: number }
  /** An ambulance is dispatched from a random entry to a random destination; how fast it gets through is scored. */
  | { atS: number; kind: "ambulance" }
  /** Two cars collide on an open stretch. They block their lane until a police car actually reaches them. */
  | { atS: number; kind: "crash" }
  /** The weather turns for `durationS` seconds (slower, more cautious drivers), then goes back to what the player set. */
  | { atS: number; kind: "weather"; weather: Exclude<Weather, "clear">; durationS: number }
  /** Every entry's demand is multiplied for `durationS` seconds, then returns to normal. */
  | { atS: number; kind: "surge"; multiplier: number; durationS: number }
  /** A wrecker is sent to the oldest incident nobody has sent one to (what the player's tap on a pin does, at an exact moment, for tests). */
  | { atS: number; kind: "dispatchWrecker" }
  /** A semi breaks down in the middle lane of a freeway and stays there until a wrecker arrives (or a long time passes). */
  | { atS: number; kind: "stall" }
  /** Debris falls into a lane and blocks it until a wrecker clears it. */
  | { atS: number; kind: "debris" }
  /** A fender bender on an elevated road. Like any crash it blocks a lane, and a wrecker can clear it. */
  | { atS: number; kind: "fender" };

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
  /** True for the auto-generated ring segments of a roundabout — always outranks any road class at a junction. */
  isRoundaboutRing?: boolean;
  /**
   * Player-set lane arrows: for each lane (index 0 = leftmost), the moves it may make at the end of this
   * edge. Omitted = automatic assignment by exit heading. Ignored if its length doesn't match `lanes`.
   */
  laneMoves?: LaneMove[][];
  /** True for an auto-generated Texas turnaround slip lane — always yields at its merge, below any real road class's priority. */
  isTexasTurnaround?: boolean;
  /** A lane is set aside: the right-hand one for buses or bikes, the left-hand one for carpools (HOV) or a toll express lane. Needs 2+ lanes; ignored otherwise. */
  reservedLane?: ReservedLane;
  /** Turns banned at the end of this road (drivers route around them). Only left and right: a road can't ban going straight. */
  bannedTurns?: ("left" | "right")[];
  /** A mid-block pedestrian crossing: traffic stops for people who press the button. */
  crosswalk?: boolean;
  /** A bus stop on this side of the road: buses on a route through here stop, and pick up more riders. */
  busStop?: boolean;
  /** Street parking along this side: a little income, and drivers slow down looking for a space. */
  parking?: boolean;
  /** People want to cross here whether or not there is a crossing; without one they step out into traffic. Set by levels. */
  jaywalkers?: boolean;
  /**
   * Variable speed limit: an advisory shown on this road's overhead gantry, at or below the posted limit. Omitted =
   * the posted limit applies.
   */
  vslMph?: number;
  /** Lanes (0 = leftmost) closed from the gantry onward: a red X over them. Traffic merges out of them. */
  closedLanes?: number[];
  /**
   * Continuous-flow intersection: left turns from this road cross over to the far side of the road ahead of the
   * junction, so they run with the through traffic and never yield to oncoming cars.
   */
  displacedLeft?: boolean;
  /** The street's name, or for a ramp where it leads (from the map data); shown on exit signs. */
  name?: string;
  /** Route reference such as "I 35", for route shields. */
  ref?: string;
  /** A ramp or link road, whose `name` says where it leads rather than what it is called. */
  ramp?: boolean;
}

/**
 * Who a set-aside lane is for. Bus and bike lanes are the right-hand lane; a carpool (HOV) lane and a toll express lane
 * are the left-hand one: buses, bikes' ban and the tolls are in the sim (see isReservedAgainst).
 */
export type ReservedLane = "bus" | "bike" | "hov" | "express";

export type Weather = "clear" | "rain" | "fog";

/** The number each kind is sent as in the snapshot (see VehicleRenderer, which turns it back into a shape). */
export const VEHICLE_KIND_CODE: Record<VehicleKind, number> = { car: 0, truck: 1, bus: 2, bike: 3, ambulance: 4, police: 5, wrecker: 6, debris: 7 };
export const VEHICLE_KIND_BY_CODE: VehicleKind[] = ["car", "truck", "bus", "bike", "ambulance", "police", "wrecker", "debris"];

/** A bus line the player has drawn: a connected run of roads that buses drive end to end, one every `headwayS` seconds. */
export interface TransitLine {
  id: string;
  name: string;
  /** Consecutive roads, each starting where the last one ends. */
  edgeIds: string[];
  headwayS: number;
  /** Display colour. */
  color: string;
  /** Buses wait at a stop until they are a fair headway behind the bus ahead, so a bunched pair is pulled apart (at the cost of waiting). */
  hold?: boolean;
}

/** How the run's bus service is going. Headways are sim-seconds between consecutive line buses boarding at the same stop. */
export interface TransitStats {
  /** Stops served by a bus on one of the player's lines. */
  services: number;
  /** Mean gap between line buses at a stop, and its spread (standard deviation / mean: 0 is even spacing, 1 is as bunched as random arrivals). 0 until measured. */
  headwayMeanS: number;
  headwayCv: number;
  /** People who boarded a bus at a stop, and those among them changing lines at a transfer stop. */
  boarded: number;
  transfers: number;
  /** Total seconds buses were held to even out spacing. */
  heldS: number;
}

/** What a simulated road user is. Most are cars; the rest only appear when the level or sandbox asks for mixed traffic. */
/** A wrecker (tow truck) comes when sent to an incident; debris is road litter that blocks a lane until it is cleared. */
export type VehicleKind = "car" | "truck" | "bus" | "bike" | "ambulance" | "police" | "wrecker" | "debris";

/** The editable network as plain, structured-cloneable data. */
export interface NetworkSnapshot {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

// ---------------------------------------------------------------------------
// Assembled/runtime network (built from a NetworkSnapshot by assembleNetwork)
// ---------------------------------------------------------------------------

/**
 * How a ramp sits against the through road it merges into or splits from, measured at each of the ramp's ends that
 * meets one. Samples run outward from the junction in steps of `JOIN_STEP_FT`.
 */
export interface JoinPad {
  /** Distance from the junction covered by the samples, ft. */
  reach: number;
  /** This road's centreline, as a distance from the through road's centreline, at each sample (always >= 0). */
  gap: number[];
  /** Half the through road's paved width, ft. */
  mainHalf: number;
  /** Which way "away from the through road" lies in this road's own right-hand frame: +1 = right, -1 = left. */
  awaySign: 1 | -1;
  /** Which side of the through road this one joins from: +1 = its right, -1 = its left. */
  sideOfMain: 1 | -1;
  /** The through road's outer edge beside this one at each sample, as flat [x, y, z, ...]. */
  mainEdge: number[];
  /** Distance from the junction up to which this road runs hard against the through road (an added lane). */
  adjacentUntil: number;
}

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
  isRoundaboutRing: boolean;
  isTexasTurnaround: boolean;
  /**
   * How far (ft) this carriageway sits to the right of the road's centerline spline. The two directions of a
   * two-way road are drawn side by side, each shifted to its own right (half the median further on divided
   * roads); one-way roads and rings have none.
   */
  lateralShiftFt: number;
  /** Vehicles drift toward the centerline over the last/first stretch of an end that meets a junction or dead end, instead of snapping sideways. */
  shiftTaperStart: boolean;
  shiftTaperEnd: boolean;
  /** Where this road carries on into one with a different carriageway shift (more or fewer lanes), its shift eases to that road's over `len` feet, so the pavements meet on one line. */
  shiftBlendStart: { to: number; len: number } | null;
  shiftBlendEnd: { to: number; len: number } | null;
  /** This end meets three or more roads (a merge, diverge or crossing), where barriers and edge lines must stop short. */
  startsAtJunction: boolean;
  endsAtJunction: boolean;
  /**
   * Length (ft) over which this road narrows toward its centreline at an end where it merges into, or splits off,
   * a bigger road, so a ramp's pavement ends as a taper inside the main road instead of a blunt slab. 0 = no taper.
   */
  taperStartFt: number;
  taperEndFt: number;
  /** Pavement scale (fraction of full width) right at the start / end, reached by the taper above. */
  startScale: number;
  endScale: number;
  /** Set where this road merges into / splits from a bigger one: the pavement rides alongside it as an added lane. */
  padStart?: JoinPad;
  padEnd?: JoinPad;
  /** A real underpass or cutting (dips well below ground). Everything else is kept at or above the grass. */
  sunken: boolean;
  /** Distances (ft, rounded) along a bridge where a pier would stand on a road below it and is left out. Set by the renderer. */
  pierSkips?: Set<number>;
  /** Which kind of road user the reserved lane is for (bus and bike: the rightmost lane; carpool and express: the leftmost), or null. */
  reservedLane: ReservedLane | null;
  /** Turns banned at the end of this road, and every road it could lead into before the bans were applied. */
  bannedTurns: LaneMove[];
  allNextEdgeIds: string[];
  crosswalk: boolean;
  jaywalkers: boolean;
  busStop: boolean;
  parking: boolean;
  /** The advisory speed limit on this road's gantry, or null for the posted limit. */
  vslMph: number | null;
  /** Per lane (0 = leftmost): true if the lane is closed from the gantry onward. All false = nothing closed. */
  closedLanes: boolean[];
  /** Left turns from this road run as a continuous-flow (displaced) turn. */
  displacedLeft: boolean;
  name?: string;
  ref?: string;
  ramp?: boolean;
  /** IDs of edges that this edge may transition into at its terminal node. */
  nextEdgeIds: string[];
  /** Player-set lane arrows copied from the spec (null = automatic). */
  manualLaneMoves: LaneMove[][] | null;
  /** Classification of each next edge by exit heading relative to this edge's end. */
  nextMoves: Map<string, LaneMove>;
  /**
   * When this edge diverges into 2+ next edges: for each next edge id, which lanes may take it
   * (index 0 = leftmost). Null when there's only one exit, so any lane works.
   */
  laneAllowed: Map<string, boolean[]> | null;
  /** Effective moves per lane (manual arrows if set and valid, else automatic) — what's painted and what cars obey. */
  laneMoves: LaneMove[][];
  /** The automatic per-lane moves, so the UI can show/reset to them. */
  autoLaneMoves: LaneMove[][];
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
  /**
   * Personal cruising-speed preference as a multiplier of whatever edge's
   * speed limit the vehicle is currently on (e.g. 1.08 = likes to cruise 8%
   * over the limit). Recomputed against the current edge every tick rather
   * than fixed at spawn, so a vehicle actually speeds up after merging onto
   * a faster road instead of keeping the pace of the road it started on.
   */
  speedFactor: number;
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
  /** Sim time until which this vehicle is broken down (stopped dead, hazards on). 0 = running normally. */
  frozenUntil: number;
  /** Seconds spent stopped at the end of a road in a lane that may not make the turn it needs; past a limit it goes anyway so nothing deadlocks. */
  wrongLaneWaitS: number;
  /** Consecutive sim-seconds spent at near-zero speed — drives gridlock detection/despawn. */
  stuckTimeS: number;
  /** True for the 15% of vehicles simulated as 18-wheeler semis rather than passenger sedans. */
  isTruck: boolean;
  kind: VehicleKind;
  /** People on board, for the "people moved" score: a bus carries far more than a car. */
  passengers: number;
  /** Hard ceiling on this vehicle's speed regardless of the limit (a bicycle, say). Infinity = none. */
  maxSpeedFtps: number;
  /** The road whose stop this bus has already served (or passed), so it never stops twice for the same one. */
  stopServedEdge: string;
  /** Sim time at which this bus finishes boarding and moves on; 0 when not at a stop. */
  dwellUntil: number;
  /** While the sim clock is below this, an ambulance is behind this vehicle and it should pull out of that lane. */
  yieldUntil: number;
  yieldLane: number;
  /** Weight-to-power ratio, lb/hp — drives how hard road grade hits this vehicle's climbing speed. */
  weightToPowerLbPerHp: number;
  /** Fixed body paint color (0-1 components), assigned once at spawn from a truck- or sedan-specific palette. */
  bodyColorR: number;
  bodyColorG: number;
  bodyColorB: number;
  /** A responder stuck in a queue driving up the shoulder instead, ignoring the cars in its lane. */
  shoulder: boolean;
  /** Seconds a responder has been held up (it takes to the shoulder after a few). */
  blockedS: number;
  /** Seconds spent waiting at the stop line for a gap to turn left; leftMark dedupes within a tick. */
  leftWaitS: number;
  leftMark: number;
  /** Slowest speed (ft/s) since the last signal it passed, and how many signals in a row it has cleared without braking hard. */
  minSpeed: number;
  comboLegs: number;
  /** The player's bus line this bus runs on ("" for any other vehicle), the riders it is boarding at its stop now, and how long it has been held there (and since when the bus ahead boarded). */
  lineId: string;
  boarding: number;
  holdS: number;
  holdFrom: number;
}

// ---------------------------------------------------------------------------
// Worker message protocol
// ---------------------------------------------------------------------------

export type WorkerInMessage =
  | { type: "updateNetwork"; network: NetworkSnapshot; seed: number }
  | { type: "setRunning"; running: boolean }
  | { type: "setSpeedMultiplier"; value: number }
  | { type: "setMaxVehicles"; value: number }
  /** Clears every vehicle, the clock, demand overrides and scoring samples — a fresh run. Send before `updateNetwork`. */
  | { type: "reset" }
  /** Replaces the run's scripted events (times in sim-seconds since the run started). Send after `reset`/`updateNetwork`. */
  | { type: "scheduleEvents"; events: ScriptedEvent[] }
  /** Breaks down one random moving car on an open stretch of road for `durationS` sim-seconds, so traffic has to cope with a blockage. */
  | { type: "breakdown"; durationS: number }
  /** Live tweaks while traffic is running: speed limits and lane arrows per edge, signal/priority control per node. */
  | { type: "patchEdges"; edges: EdgePatch[] }
  /** How much of the traffic is buses and bikes (0-1 each). Zero keeps the classic cars-and-trucks mix. */
  | { type: "setTrafficMix"; bus: number; bike: number }
  /** Dispatches an ambulance now (Chaos mode, sandbox button). */
  | { type: "ambulance" }
  /** Causes a crash now (Chaos mode). */
  | { type: "crash" }
  /** Starts an incident now: a stalled semi, debris in a lane, or a fender bender on a flyover. */
  | { type: "incident"; kind: "stall" | "debris" | "fender"; /** Put a debris spill on this road (an oil slick, a dropped load). */ edgeId?: string }
  | { type: "setRageWeaves"; enabled: boolean }
  /** Sends a wrecker to an open incident. */
  | { type: "dispatchWrecker"; incidentId: number }
  /** Whether left turns at signals give way to oncoming traffic (off for the classic levels, on where realistic left turns matter). */
  | { type: "setLeftTurnsYield"; enabled: boolean }
  /** The player's bus lines. Buses run on them on a timetable, on top of any bus traffic from the mix. */
  | { type: "setTransit"; lines: TransitLine[] }
  /** The weather the player picked. Scripted weather events override it while they last. */
  | { type: "setWeather"; weather: Weather }
  /** How dark it is (0 day, 0.5 dusk, 1 night). Drivers are more careful on unlit roads, and see people late. */
  | { type: "setDarkness"; level: number }
  /** Turns the 24-hour demand cycle on or off: demand follows rush hours and the clock starts at `startHour`, one day lasting `dayLengthS` sim-seconds. */
  | { type: "setDayCycle"; enabled: boolean; startHour: number; dayLengthS: number }
  | { type: "patchNodes"; nodes: { id: string; control: JunctionControl | null }[] }
  | { type: "setDemand"; edgeId: string; vehiclesPerHour: number }
  | { type: "setColorMode"; heatmap: boolean }
  | { type: "returnBuffers"; matrices: ArrayBuffer; colors: ArrayBuffer; taillightColors: ArrayBuffer };

/** A live edit to one road while traffic runs. */
export interface EdgePatch {
  id: string;
  speedLimitMph: number;
  laneMoves: LaneMove[][] | null;
  reservedLane?: ReservedLane | null;
  bannedTurns?: LaneMove[];
  crosswalk?: boolean;
  busStop?: boolean;
  parking?: boolean;
  vslMph?: number | null;
  closedLanes?: number[];
  displacedLeft?: boolean;
}

/** How the run's emergency responses are going. Times are sim-seconds; "ideal" is the route at the ambulance's own free-flow speed. */
export interface EmergencyStats {
  dispatched: number;
  completed: number;
  /** Dispatched but not yet on the road because every lane at the entry was busy. */
  waiting: number;
  active: number;
  totalResponseS: number;
  totalIdealS: number;
  lastResponseS: number;
  lastIdealS: number;
}

/** How the run's crashes are going. Times are sim-seconds from the crash to the road being clear. */
export interface CrashStats {
  happened: number;
  cleared: number;
  /** Crashes still blocking a lane right now. */
  open: number;
  totalClearS: number;
  lastClearS: number;
}

export interface ContractStatus {
  edgeId: string;
  targetSpeedMph: number;
  actualSpeedMph: number;
  sampleCount: number;
  meetsThreshold: boolean;
}

/** Per-edge average speed as a fraction of that edge's speed limit (0 = gridlock, 1 = free-flow), for the traffic heatmap. */
export type EdgeSpeedRatio = [edgeId: string, ratio: number];

/** An open incident as the interface sees it. */
export interface IncidentView {
  id: number;
  kind: "crash" | "stall" | "debris";
  edgeId: string;
  position: [number, number, number];
  /** Sim-seconds since it began. */
  ageS: number;
  /** "none": nobody sent; "enroute": a wrecker is driving there; "onscene": it is clearing the road. */
  wrecker: "none" | "enroute" | "onscene";
  /** True on an elevated road. */
  elevated: boolean;
}

export interface TickStats {
  /** World positions of vehicles currently broken down, for the warning marker. */
  incidentMarkers: [number, number, number][];
  contracts: ContractStatus[];
  edgeSpeedRatios: EdgeSpeedRatio[];
  /** Edge IDs that have been badly congested (well under the speed limit) for a sustained stretch of time — surfaced as warning markers so players can spot trouble without reading stats. */
  problemEdgeIds: string[];
  /** Live Level-of-Service / v-c / flow stats per edge, for the Inspect panel. */
  edgeTrafficStats: EdgeTrafficStats[];
  /** Total vehicles forcibly despawned after sitting gridlocked (near-zero speed) for GRIDLOCK_DESPAWN_S — a throughput penalty counter. */
  gridlockPenaltyTotal: number;
  /** World positions of currently-stuck vehicles that have crossed the warning threshold but haven't been despawned yet, for the pulsing exclamation marker. */
  gridlockMarkers: [number, number, number][];
  /** What each approach's signal shows right now: [edgeId, 0 red | 1 green | 2 left-turn arrow only | 3 amber]. */
  signalHeads: [string, number][];
}

export type WorkerOutMessage =
  | { type: "ready" }
  | {
      type: "tick";
      matrices: ArrayBuffer;
      colors: ArrayBuffer;
      /** Per-vehicle taillight tint (3 floats each): dim red at cruise, brightening toward white-hot when braking hard (accel below the hard-brake threshold). */
      taillightColors: ArrayBuffer;
      activeCount: number;
      simTime: number;
      avgSpeedFtS: number;
      throughputLastMinute: number;
      spawnedTotal: number;
      emergency: EmergencyStats;
      crashes: CrashStats;
      /** The weather in effect right now (the player's choice, or a scripted storm). */
      weather: Weather;
      /** Clock hour 0-24 while the day cycle is on, else -1. */
      clockHour: number;
      /** World positions of ambulances on the road right now, for the pins. */
      ambulances: [number, number, number][];
      /** Open incidents, for their markers and the wrecker button. */
      incidents: IncidentView[];
      /** Where semis are braking hard on a downgrade (engine-brake rumble), nearest few. */
      jakeBrakes: [number, number, number][];
      /** Where drivers who have sat stopped for over five seconds are fuming (at most a dozen, spread out), and how many there are. */
      rageMarkers: [number, number, number][];
      rageCount: number;
      /** Flow combos earned this run: a platoon of ten cleared two signals in a row without slowing. */
      combos: number;
      /** People who have crossed at a crossing or stepped into traffic since the run began. */
      pedServedTotal: number;
      /** Times someone stepped into traffic with cars coming (no marked crossing there). */
      pedIncidentsTotal: number;
      /** Crossings with people on the road right now: [x, y, z, rightX, rightZ, halfWidth, progress 0-1, direction, marked 1/0]. */
      pedCrossings: number[][];
      /** People carried by the vehicles that completed their routes (a bus counts for all its riders). */
      peopleMovedTotal: number;
      /** Service quality: seconds cars and trucks lost against an empty road over `tripsTimed` finished trips (and the empty-road time for the same trips), and the longest line of stopped cars now and this run. */
      tripDelayTotalS: number;
      tripFreeFlowTotalS: number;
      tripsTimed: number;
      queueNowFt: number;
      queuePeakFt: number;
      /** Car-seconds spent in toll express lanes since the run began (each pays a toll). */
      expressVehicleS: number;
      transit: TransitStats;
      /** Cumulative count of vehicles that actually completed their route (excludes gridlock-forced despawns) since the network was last (re)loaded. */
      completedTripsTotal: number;
      /** The heavy per-edge statistics. Only present on ticks where they were recomputed (about 5 per second); the main thread keeps the last set. */
      stats?: TickStats;
    };
