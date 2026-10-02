import * as THREE from "three";
import type { Edge3D } from "./types";

/**
 * Shared, allocation-free helpers for sampling per-lane world-space points
 * along an edge's centerline spline. Used both by the simulation worker
 * (hot path, every vehicle every tick) and by the road mesh builder
 * (cold path, run once at startup) — callers always supply their own
 * scratch vectors so this module never allocates.
 */

const _upVector = new THREE.Vector3(0, 1, 0);

function clampT(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Signed lateral offset (feet) of a lane's centerline from the edge centerline. */
export function laneOffsetFt(
  laneIndex: number,
  lanes: number,
  laneWidthFt: number
): number {
  return (laneIndex - (lanes - 1) / 2) * laneWidthFt;
}

/** Stretch (ft) over which vehicles move between their carriageway and the junction centre. */
const SHIFT_TAPER_FT = 55;

function smooth01(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
}

/** How narrow a tapering end gets (fraction of full width) right at the node. */
const TAPER_MIN_SCALE = 0.1;

/** 1 along most of a road; shrinks toward the node over a merge or diverge taper so pavement and lanes close in together. */
export function widthScaleAt(edge: Edge3D, distanceFt: number): number {
  let k = 1;
  if (edge.taperStartFt > 0 && distanceFt < edge.taperStartFt) {
    k = Math.min(k, TAPER_MIN_SCALE + (1 - TAPER_MIN_SCALE) * smooth01(distanceFt / edge.taperStartFt));
  }
  const toEnd = edge.length - distanceFt;
  if (edge.taperEndFt > 0 && toEnd < edge.taperEndFt) {
    k = Math.min(k, TAPER_MIN_SCALE + (1 - TAPER_MIN_SCALE) * smooth01(toEnd / edge.taperEndFt));
  }
  return k;
}

/** Where a vehicle at `distanceFt` along the edge really sits laterally: the carriageway shift, eased to zero into junctions. */
export function lateralShiftAt(edge: Edge3D, distanceFt: number): number {
  if (edge.lateralShiftFt === 0) return 0;
  const taper = Math.min(SHIFT_TAPER_FT, edge.length / 2);
  let k = 1;
  if (edge.shiftTaperStart) k = Math.min(k, smooth01(distanceFt / taper));
  if (edge.shiftTaperEnd) k = Math.min(k, smooth01((edge.length - distanceFt) / taper));
  return edge.lateralShiftFt * k;
}

/** Writes the normalized "right" direction (perpendicular to travel, in the horizontal plane) into `out`. */
export function edgeRightVectorAt(
  edge: Edge3D,
  t: number,
  tangentScratch: THREE.Vector3,
  out: THREE.Vector3
): THREE.Vector3 {
  edge.spline.getTangentAt(clampT(t), tangentScratch);
  out.crossVectors(tangentScratch, _upVector);
  if (out.lengthSq() < 1e-8) {
    out.set(1, 0, 0);
  } else {
    out.normalize();
  }
  return out;
}

/** Writes the world-space centerline point at parameter t into `out`. */
export function edgePointAt(
  edge: Edge3D,
  t: number,
  out: THREE.Vector3
): THREE.Vector3 {
  edge.spline.getPointAt(clampT(t), out);
  return out;
}

/** Writes the world-space tangent (unit, direction of travel) at parameter t into `out`. */
export function edgeTangentAt(
  edge: Edge3D,
  t: number,
  out: THREE.Vector3
): THREE.Vector3 {
  edge.spline.getTangentAt(clampT(t), out);
  return out;
}

/**
 * Writes the world-space point of a specific lane's centerline at
 * parameter t into `out`. `tangentScratch` and `rightScratch` are
 * caller-owned temporaries to keep this call allocation-free.
 */
export function laneCenterPointAt(
  edge: Edge3D,
  t: number,
  laneIndex: number,
  tangentScratch: THREE.Vector3,
  rightScratch: THREE.Vector3,
  out: THREE.Vector3
): THREE.Vector3 {
  const ct = clampT(t);
  edgePointAt(edge, ct, out);
  edgeRightVectorAt(edge, ct, tangentScratch, rightScratch);
  const d = ct * edge.length;
  const offset = laneOffsetFt(laneIndex, edge.lanes, edge.laneWidthFt) * widthScaleAt(edge, d) + lateralShiftAt(edge, d);
  out.addScaledVector(rightScratch, offset);
  if (!edge.sunken && out.y < 0) out.y = 0;
  return out;
}

/** Converts an arc-length distance along an edge into the curve's normalized [0,1] parameter. */
export function distanceToT(edge: Edge3D, distanceFt: number): number {
  const clamped = distanceFt <= 0 ? 0 : distanceFt >= edge.length ? edge.length : distanceFt;
  return edge.length > 0 ? clamped / edge.length : 0;
}
