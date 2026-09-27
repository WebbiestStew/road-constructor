import * as THREE from "three";
import { edgePointAt, edgeRightVectorAt, laneOffsetFt } from "@/sim/laneGeometry";
import type { Edge3D } from "@/sim/types";

/** A single point of a 2D cross-section profile: x = lateral (along the road's "right" vector), y = vertical (world up). */
export interface ProfilePoint {
  x: number;
  y: number;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function segmentsForLength(lengthFt: number, minSegments = 16, ftPerSegment = 35): number {
  return Math.max(minSegments, Math.round(lengthFt / ftPerSegment));
}

/**
 * Sweeps an arbitrary 2D cross-section profile along an edge's centerline
 * spline, offset laterally by `centerlineOffsetFt`. This single primitive
 * builds every piece of road geometry in this file — flat ribbons (a
 * 2-point profile), painted stripes (a thin 2-point profile raised
 * slightly above the road surface), and Jersey barriers (a closed
 * multi-point profile) are all just different profiles swept the same way.
 */
export function sweepProfileAlongCurve(
  edge: Edge3D,
  centerlineOffsetFt: number,
  profile: ProfilePoint[],
  segments: number,
  closed = false,
  tStart = 0,
  tEnd = 1
): THREE.BufferGeometry {
  const tangentScratch = new THREE.Vector3();
  const rightScratch = new THREE.Vector3();
  const pointScratch = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = tStart + (tEnd - tStart) * (i / segments);
    edgePointAt(edge, t, pointScratch);
    edgeRightVectorAt(edge, t, tangentScratch, rightScratch);
    const railOrigin = pointScratch.clone().addScaledVector(rightScratch, centerlineOffsetFt);
    const ring: THREE.Vector3[] = profile.map((p) =>
      railOrigin.clone().addScaledVector(rightScratch, p.x).addScaledVector(up, p.y)
    );
    rings.push(ring);
  }

  const ringCount = profile.length;
  const profileEdges = closed ? ringCount : ringCount - 1;
  const positions: number[] = [];

  for (let i = 0; i < segments; i++) {
    const ringA = rings[i];
    const ringB = rings[i + 1];
    for (let j = 0; j < profileEdges; j++) {
      const j2 = (j + 1) % ringCount;
      const a = ringA[j];
      const b = ringA[j2];
      const c = ringB[j2];
      const d = ringB[j];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Builds the flat paved asphalt ribbon for an edge, spanning all lanes plus shoulders. */
export function buildAsphaltRibbon(edge: Edge3D, shoulderFt = 4): THREE.BufferGeometry {
  const halfWidth = (edge.lanes * edge.laneWidthFt) / 2 + shoulderFt;
  const profile: ProfilePoint[] = [
    { x: -halfWidth, y: 0 },
    { x: halfWidth, y: 0 },
  ];
  return sweepProfileAlongCurve(edge, 0, profile, segmentsForLength(edge.length));
}

/** Builds a continuous solid stripe (edge lines, medians) at a given lateral offset. */
export function buildSolidStripe(
  edge: Edge3D,
  lateralOffsetFt: number,
  widthFt = 0.45,
  verticalOffsetFt = 0.03
): THREE.BufferGeometry {
  const profile: ProfilePoint[] = [
    { x: -widthFt / 2, y: verticalOffsetFt },
    { x: widthFt / 2, y: verticalOffsetFt },
  ];
  return sweepProfileAlongCurve(edge, lateralOffsetFt, profile, segmentsForLength(edge.length, 12));
}

/** Builds a solid stop-bar stripe spanning the full paved width, a short distance before the edge's end — the painted line drivers hold behind at a junction. */
export function buildStopBar(
  edge: Edge3D,
  distanceBeforeEndFt = 4,
  thicknessFt = 1.5,
  verticalOffsetFt = 0.035
): THREE.BufferGeometry {
  const halfWidth = (edge.lanes * edge.laneWidthFt) / 2;
  const profile: ProfilePoint[] = [
    { x: -halfWidth, y: verticalOffsetFt },
    { x: halfWidth, y: verticalOffsetFt },
  ];
  const distEnd = Math.max(thicknessFt, edge.length - distanceBeforeEndFt);
  const distStart = Math.max(0, distEnd - thicknessFt);
  const tStart = clamp01(distStart / edge.length);
  const tEnd = clamp01(distEnd / edge.length);
  return sweepProfileAlongCurve(edge, 0, profile, 2, false, tStart, tEnd);
}

/** Builds a "ladder" crosswalk: several longitudinal bars spread across the paved width, in a short band before the edge's end. */
export function buildCrosswalkBars(
  edge: Edge3D,
  distanceBeforeEndFt = 18,
  bandLengthFt = 10,
  barWidthFt = 2,
  gapFt = 2.2,
  verticalOffsetFt = 0.035
): THREE.BufferGeometry[] {
  const halfWidth = (edge.lanes * edge.laneWidthFt) / 2;
  const distEnd = Math.max(bandLengthFt, edge.length - distanceBeforeEndFt);
  const distStart = Math.max(0, distEnd - bandLengthFt);
  const tStart = clamp01(distStart / edge.length);
  const tEnd = clamp01(distEnd / edge.length);

  const bars: THREE.BufferGeometry[] = [];
  const step = barWidthFt + gapFt;
  for (let x = -halfWidth + barWidthFt / 2 + 0.5; x <= halfWidth - barWidthFt / 2 - 0.5; x += step) {
    const profile: ProfilePoint[] = [
      { x: -barWidthFt / 2, y: verticalOffsetFt },
      { x: barWidthFt / 2, y: verticalOffsetFt },
    ];
    bars.push(sweepProfileAlongCurve(edge, x, profile, 2, false, tStart, tEnd));
  }
  return bars;
}

/** Builds a dashed stripe (lane separators) at a given lateral offset, merged into one geometry. */
export function buildDashedStripe(
  edge: Edge3D,
  lateralOffsetFt: number,
  widthFt = 0.4,
  dashLenFt = 10,
  gapLenFt = 30,
  verticalOffsetFt = 0.03
): THREE.BufferGeometry {
  const totalLen = edge.length;
  const cycle = dashLenFt + gapLenFt;
  const tangentScratch = new THREE.Vector3();
  const rightScratch = new THREE.Vector3();
  const pointScratch = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const sample = (distFt: number, lateral: number, out: THREE.Vector3) => {
    const t = clamp01(distFt / totalLen);
    edgePointAt(edge, t, pointScratch);
    edgeRightVectorAt(edge, t, tangentScratch, rightScratch);
    out.copy(pointScratch).addScaledVector(rightScratch, lateral).addScaledVector(up, verticalOffsetFt);
  };

  const positions: number[] = [];
  const subSamples = 3;

  for (let s = 0; s < totalLen; s += cycle) {
    const dashStart = s;
    const dashEnd = Math.min(s + dashLenFt, totalLen);
    if (dashEnd <= dashStart) continue;

    const left: THREE.Vector3[] = [];
    const right: THREE.Vector3[] = [];
    for (let k = 0; k <= subSamples; k++) {
      const d = dashStart + (dashEnd - dashStart) * (k / subSamples);
      const pl = new THREE.Vector3();
      const pr = new THREE.Vector3();
      sample(d, lateralOffsetFt - widthFt / 2, pl);
      sample(d, lateralOffsetFt + widthFt / 2, pr);
      left.push(pl);
      right.push(pr);
    }
    for (let k = 0; k < subSamples; k++) {
      const a = left[k];
      const b = right[k];
      const c = right[k + 1];
      const d = left[k + 1];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Builds periodic painted direction-arrow chevrons down the centerline of a single lane. */
export function buildLaneArrows(
  edge: Edge3D,
  laneIndex: number,
  spacingFt = 140,
  lengthFt = 16,
  widthFt = 5,
  verticalOffsetFt = 0.04,
  turnBias = 0
): THREE.BufferGeometry {
  const totalLen = edge.length;
  const tangentScratch = new THREE.Vector3();
  const rightScratch = new THREE.Vector3();
  const pointScratch = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const laneOffset = laneOffsetFt(laneIndex, edge.lanes, edge.laneWidthFt);
  // A turn lane's arrowhead kinks sideways toward its exit direction instead
  // of pointing straight ahead, so drivers read it the way real lane-use
  // signage reads: straight arrow for through lanes, angled for turn lanes.
  const tipSkew = turnBias * widthFt * 0.7;

  const positions: number[] = [];
  const startOffset = spacingFt * 0.5;

  for (let s = startOffset; s < totalLen - lengthFt; s += spacingFt) {
    const tMid = clamp01((s + lengthFt / 2) / totalLen);
    edgePointAt(edge, tMid, pointScratch);
    edgeRightVectorAt(edge, tMid, tangentScratch, rightScratch);
    const forward = tangentScratch;

    const center = pointScratch
      .clone()
      .addScaledVector(rightScratch, laneOffset)
      .addScaledVector(up, verticalOffsetFt);

    const tip = center
      .clone()
      .addScaledVector(forward, lengthFt / 2)
      .addScaledVector(rightScratch, tipSkew);
    const backLeft = center
      .clone()
      .addScaledVector(forward, -lengthFt / 2)
      .addScaledVector(rightScratch, -widthFt / 2);
    const backRight = center
      .clone()
      .addScaledVector(forward, -lengthFt / 2)
      .addScaledVector(rightScratch, widthFt / 2);

    positions.push(tip.x, tip.y, tip.z, backLeft.x, backLeft.y, backLeft.z, backRight.x, backRight.y, backRight.z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Simplified Jersey barrier cross-section (in feet), traced as a closed loop. */
const JERSEY_PROFILE: ProfilePoint[] = [
  { x: -1.0, y: 0 },
  { x: 1.0, y: 0 },
  { x: 0.6, y: 1.25 },
  { x: 0.35, y: 2.75 },
  { x: -0.35, y: 2.75 },
  { x: -0.6, y: 1.25 },
];

export function buildJerseyBarrier(edge: Edge3D, lateralOffsetFt: number): THREE.BufferGeometry {
  return sweepProfileAlongCurve(edge, lateralOffsetFt, JERSEY_PROFILE, segmentsForLength(edge.length, 12), true);
}

/**
 * A tapered rectangular concrete bent column — wider at the footing than
 * under the cap beam, like a real bridge pier. Built as a 4-sided prism
 * (a "cylinder" with 4 radial segments is just a square prism) rotated 45°
 * so its flat faces line up with the cap beam's axes instead of a diamond.
 * The `radius` of an N=4 cylinder is measured to its corner, so half-widths
 * are scaled by sqrt(2) to land the flat faces at the requested width.
 */
export function buildTaperedPierColumn(topHalfWidthFt: number, baseHalfWidthFt: number, heightFt: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(topHalfWidthFt * Math.SQRT2, baseHalfWidthFt * Math.SQRT2, heightFt, 4, 1);
  geo.rotateY(Math.PI / 4);
  return geo;
}

export interface PierDescriptor {
  /** World-space position of the pier cap beam center, feet. */
  capPosition: [number, number, number];
  /** Rotation about Y (radians) aligning the cap beam across the roadway. */
  rotationY: number;
  /** Length of the cap beam (spanning the paved width), feet. */
  capLength: number;
  /** Height from ground (y=0) to the underside of the cap beam, feet. */
  columnHeight: number;
  /** Lateral offsets (feet, along the cap beam) of individual column centers. */
  columnOffsets: number[];
}

/**
 * Computes bridge pier / bent locations for an elevated edge: sampled at
 * regular intervals along the centerline wherever the deck is raised more
 * than 2 ft above grade.
 */
export function computePierDescriptors(edge: Edge3D, intervalFt = 90): PierDescriptor[] {
  if (!edge.isElevated) return [];

  const tangentScratch = new THREE.Vector3();
  const rightScratch = new THREE.Vector3();
  const pointScratch = new THREE.Vector3();
  const pavedHalfWidth = (edge.lanes * edge.laneWidthFt) / 2 + 2;

  const descriptors: PierDescriptor[] = [];
  for (let dist = intervalFt / 2; dist < edge.length; dist += intervalFt) {
    const t = clamp01(dist / edge.length);
    edgePointAt(edge, t, pointScratch);
    if (pointScratch.y <= 2) continue;
    edgeRightVectorAt(edge, t, tangentScratch, rightScratch);
    const rotationY = Math.atan2(rightScratch.x, rightScratch.z);
    descriptors.push({
      capPosition: [pointScratch.x, pointScratch.y - 1.2, pointScratch.z],
      rotationY,
      capLength: pavedHalfWidth * 2,
      columnHeight: Math.max(pointScratch.y - 2.2, 1),
      columnOffsets: [-pavedHalfWidth + 3, pavedHalfWidth - 3],
    });
  }
  return descriptors;
}
