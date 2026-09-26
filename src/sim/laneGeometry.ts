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
  const offset = laneOffsetFt(laneIndex, edge.lanes, edge.laneWidthFt);
  out.addScaledVector(rightScratch, offset);
  return out;
}

/** Converts an arc-length distance along an edge into the curve's normalized [0,1] parameter. */
export function distanceToT(edge: Edge3D, distanceFt: number): number {
  const clamped = distanceFt <= 0 ? 0 : distanceFt >= edge.length ? edge.length : distanceFt;
  return edge.length > 0 ? clamped / edge.length : 0;
}
