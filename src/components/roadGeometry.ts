import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { carriagewayOffsetAt, edgePointAt, edgeRightVectorAt, laneOffsetFt, widthScaleAt } from "@/sim/laneGeometry";
import { JOIN_STEP_FT, type Edge3D, type JoinPad } from "@/sim/types";

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

/** Slices for a stretch of an edge: the usual count for a whole road, proportionally fewer for a short run of it. */
function rangeSegments(edge: Edge3D, tStart: number, tEnd: number): number {
  const range = tEnd - tStart;
  return Math.max(range >= 0.999 ? 12 : 2, Math.round((edge.length * range) / 35));
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

  // A taper is only a few dozen feet long, so give a tapering road enough slices to draw it smoothly.
  if (edge.taperStartFt > 0 || edge.taperEndFt > 0) segments = Math.max(segments, Math.round(((tEnd - tStart) * edge.length) / 8));

  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = tStart + (tEnd - tStart) * (i / segments);
    edgePointAt(edge, t, pointScratch);
    edgeRightVectorAt(edge, t, tangentScratch, rightScratch);
    // Where this road tapers into another, everything across its width (pavement, lines, barriers) closes toward
    // the centreline together; the carriageway's own shift to its side of the road does not.
    const k = widthScaleAt(edge, t * edge.length);
    // A spline can overshoot a few tenths of a foot below ground at the base of a ramp; that would bury the pavement
    // and leave only barrier tops showing, so a road that isn't a real underpass is held at the surface.
    const surfaceLift = !edge.sunken && pointScratch.y < 0 ? -pointScratch.y : 0;
    const ring: THREE.Vector3[] = profile.map((p) =>
      pointScratch
        .clone()
        .addScaledVector(rightScratch, carriagewayOffsetAt(edge, t * edge.length, k) + (centerlineOffsetFt + p.x) * k)
        .addScaledVector(up, p.y + surfaceLift)
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

/**
 * Builds the paved asphalt surface for an edge, spanning all lanes plus
 * shoulders. Flat by default (a single top face); pass `deckThicknessFt` for
 * an elevated edge to instead extrude it into a solid slab with visible
 * side faces and an underside, like a real bridge deck instead of an
 * infinitely thin plane.
 */
export function buildAsphaltRibbon(edge: Edge3D, shoulderFt = 4, deckThicknessFt = 0): THREE.BufferGeometry {
  const halfWidth = (edge.lanes * edge.laneWidthFt) / 2 + shoulderFt;
  if (deckThicknessFt > 0) {
    const profile: ProfilePoint[] = [
      { x: -halfWidth, y: 0 },
      { x: halfWidth, y: 0 },
      { x: halfWidth, y: -deckThicknessFt },
      { x: -halfWidth, y: -deckThicknessFt },
    ];
    return sweepProfileAlongCurve(edge, 0, profile, segmentsForLength(edge.length), true);
  }
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
  verticalOffsetFt = 0.03,
  tStart = 0,
  tEnd = 1
): THREE.BufferGeometry {
  const profile: ProfilePoint[] = [
    { x: -widthFt / 2, y: verticalOffsetFt },
    { x: widthFt / 2, y: verticalOffsetFt },
  ];
  return sweepProfileAlongCurve(edge, lateralOffsetFt, profile, rangeSegments(edge, tStart, tEnd), false, tStart, tEnd);
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
  verticalOffsetFt = 0.03,
  fromFt = 0,
  toFt = edge.length
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
    const kk = widthScaleAt(edge, t * totalLen);
    out.copy(pointScratch).addScaledVector(rightScratch, lateral * kk + carriagewayOffsetAt(edge, t * totalLen, kk)).addScaledVector(up, verticalOffsetFt);
  };

  const positions: number[] = [];
  const subSamples = 3;

  for (let s = fromFt; s < Math.min(toFt, totalLen); s += cycle) {
    const dashStart = s;
    const dashEnd = Math.min(s + dashLenFt, toFt, totalLen);
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
  const laneOffsetBase = laneOffsetFt(laneIndex, edge.lanes, edge.laneWidthFt);
  // A turn lane's arrowhead kinks sideways toward its exit direction instead
  // of pointing straight ahead, so drivers read it the way real lane-use
  // signage reads: straight arrow for through lanes, angled for turn lanes.
  const tipSkew = turnBias * widthFt * 0.7;

  const positions: number[] = [];
  // Count back from the stop line so the last arrow always sits just before the junction, as on real roads.
  const stopLineGapFt = 26;

  for (let s = totalLen - lengthFt - stopLineGapFt; s > 0; s -= spacingFt) {
    const tMid = clamp01((s + lengthFt / 2) / totalLen);
    edgePointAt(edge, tMid, pointScratch);
    edgeRightVectorAt(edge, tMid, tangentScratch, rightScratch);
    const forward = tangentScratch;

    const center = pointScratch
      .clone()
      .addScaledVector(rightScratch, laneOffsetBase * widthScaleAt(edge, s + lengthFt / 2) + carriagewayOffsetAt(edge, s + lengthFt / 2, widthScaleAt(edge, s + lengthFt / 2)))
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

export function buildJerseyBarrier(edge: Edge3D, lateralOffsetFt: number, tStart = 0, tEnd = 1): THREE.BufferGeometry {
  return sweepProfileAlongCurve(edge, lateralOffsetFt, JERSEY_PROFILE, rangeSegments(edge, tStart, tEnd), true, tStart, tEnd);
}

/** A six-inch kerb: a low trapezoid of concrete, wide enough to read from above. */
const CURB_PROFILE: ProfilePoint[] = [
  { x: -0.6, y: 0 },
  { x: 0.6, y: 0 },
  { x: 0.45, y: 0.5 },
  { x: -0.45, y: 0.5 },
];

export function buildCurb(edge: Edge3D, lateralOffsetFt: number, tStart = 0, tEnd = 1): THREE.BufferGeometry {
  return sweepProfileAlongCurve(edge, lateralOffsetFt, CURB_PROFILE, rangeSegments(edge, tStart, tEnd), true, tStart, tEnd);
}

/** Simpler bridge parapet cross-section (in feet) — a plain vertical concrete rail, shorter than a full Jersey barrier, for non-freeway elevated roads. */
const PARAPET_PROFILE: ProfilePoint[] = [
  { x: -0.6, y: 0 },
  { x: 0.6, y: 0 },
  { x: 0.5, y: 2.2 },
  { x: -0.5, y: 2.2 },
];

export function buildParapet(edge: Edge3D, lateralOffsetFt: number, tStart = 0, tEnd = 1): THREE.BufferGeometry {
  return sweepProfileAlongCurve(edge, lateralOffsetFt, PARAPET_PROFILE, rangeSegments(edge, tStart, tEnd), true, tStart, tEnd);
}

/** Cross-sections (feet) of the Texas Classic rail: a solid curb, the open slots between posts, and a top rail. */
const TX_CURB_PROFILE: ProfilePoint[] = [
  { x: -0.65, y: 0 },
  { x: 0.65, y: 0 },
  { x: 0.55, y: 1.3 },
  { x: -0.55, y: 1.3 },
];
const TX_TOP_RAIL_PROFILE: ProfilePoint[] = [
  { x: -0.6, y: 2.4 },
  { x: 0.6, y: 2.4 },
  { x: 0.5, y: 3.3 },
  { x: -0.5, y: 3.3 },
];
const TX_POST_PROFILE: ProfilePoint[] = [
  { x: -0.55, y: 1.2 },
  { x: 0.55, y: 1.2 },
  { x: 0.55, y: 2.5 },
  { x: -0.55, y: 2.5 },
];
const TX_POST_EVERY_FT = 7;
const TX_POST_LENGTH_FT = 1.1;

/**
 * A TxDOT Texas Classic bridge rail: a concrete curb and a concrete top rail held apart by evenly spaced posts, so you
 * see through the slots between them. Returned as one merged geometry.
 */
export function buildTexasRail(edge: Edge3D, lateralOffsetFt: number, tStart = 0, tEnd = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    sweepProfileAlongCurve(edge, lateralOffsetFt, TX_CURB_PROFILE, rangeSegments(edge, tStart, tEnd), true, tStart, tEnd),
    sweepProfileAlongCurve(edge, lateralOffsetFt, TX_TOP_RAIL_PROFILE, rangeSegments(edge, tStart, tEnd), true, tStart, tEnd),
  ];
  const runFt = (tEnd - tStart) * edge.length;
  const posts = Math.max(2, Math.floor(runFt / TX_POST_EVERY_FT) + 1);
  for (let i = 0; i < posts; i++) {
    const t0 = tStart + ((tEnd - tStart) * i) / (posts - 1) - (i === posts - 1 ? TX_POST_LENGTH_FT / edge.length : 0);
    const t1 = Math.min(tEnd, t0 + TX_POST_LENGTH_FT / edge.length);
    if (t1 <= t0) continue;
    parts.push(sweepProfileAlongCurve(edge, lateralOffsetFt, TX_POST_PROFILE, 1, true, Math.max(tStart, t0), t1));
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged ?? parts[0];
}

/**
 * Builds a soft dark "contact shadow" ribbon projected flat onto the
 * ground (y ~ 0), following an elevated edge's own XZ footprint but a bit
 * wider than the deck above it — a cheap, always-visible stand-in for a
 * real shadow under a bridge deck, independent of whatever postprocessing
 * (or lack of it) the renderer has available.
 */
export function buildGroundShadowRibbon(edge: Edge3D, extraWidthFt = 4): THREE.BufferGeometry {
  const halfWidth = (edge.lanes * edge.laneWidthFt) / 2 + extraWidthFt;
  const tangentScratch = new THREE.Vector3();
  const rightScratch = new THREE.Vector3();
  const pointScratch = new THREE.Vector3();
  const segments = segmentsForLength(edge.length);

  const rings: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    edgePointAt(edge, t, pointScratch);
    edgeRightVectorAt(edge, t, tangentScratch, rightScratch);
    const ground = new THREE.Vector3(pointScratch.x, 0.05, pointScratch.z);
    ground.addScaledVector(rightScratch, carriagewayOffsetAt(edge, t * edge.length, widthScaleAt(edge, t * edge.length)));
    rings.push([
      ground.clone().addScaledVector(rightScratch, -halfWidth),
      ground.clone().addScaledVector(rightScratch, halfWidth),
    ]);
  }

  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const [a, b] = rings[i];
    const [d, c] = rings[i + 1];
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Builds a thin dark expansion-joint line across the full deck width at a fixed distance from the edge's start — marks a bridge segment boundary (e.g. at each pier). */
export function buildExpansionJoint(edge: Edge3D, distanceFromStartFt: number, thicknessFt = 0.25): THREE.BufferGeometry {
  const halfWidth = (edge.lanes * edge.laneWidthFt) / 2 + 1;
  const profile: ProfilePoint[] = [
    { x: -halfWidth, y: 0.02 },
    { x: halfWidth, y: 0.02 },
  ];
  const distStart = Math.max(0, distanceFromStartFt - thicknessFt / 2);
  const distEnd = Math.min(edge.length, distanceFromStartFt + thicknessFt / 2);
  const tStart = clamp01(distStart / edge.length);
  const tEnd = clamp01(distEnd / edge.length);
  return sweepProfileAlongCurve(edge, 0, profile, 2, false, tStart, tEnd);
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
  /** Distance along the edge's centerline, feet — used to align an expansion joint with each pier. */
  distanceFt: number;
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
/** Decks lower than this get no piers. */
const PIER_MIN_DECK_HEIGHT_FT = 7;

export function computePierDescriptors(edge: Edge3D, intervalFt = 90, ignoreSkips = false): PierDescriptor[] {
  if (!edge.isElevated) return [];

  const tangentScratch = new THREE.Vector3();
  const rightScratch = new THREE.Vector3();
  const pointScratch = new THREE.Vector3();
  const pavedHalfWidth = (edge.lanes * edge.laneWidthFt) / 2 + 2;

  const descriptors: PierDescriptor[] = [];
  for (let dist = intervalFt / 2; dist < edge.length; dist += intervalFt) {
    const t = clamp01(dist / edge.length);
    if (!ignoreSkips && edge.pierSkips?.has(Math.round(dist))) continue;
    edgePointAt(edge, t, pointScratch);
    // A deck only a few feet off the ground rests on fill, not on columns: a cap beam there would show as a slab
    // lying across the lanes.
    if (pointScratch.y <= PIER_MIN_DECK_HEIGHT_FT) continue;
    edgeRightVectorAt(edge, t, tangentScratch, rightScratch);
    const rotationY = Math.atan2(rightScratch.x, rightScratch.z);
    const k = widthScaleAt(edge, dist);
    pointScratch.addScaledVector(rightScratch, carriagewayOffsetAt(edge, dist, k));
    const half = pavedHalfWidth * k;
    descriptors.push({
      distanceFt: dist,
      capPosition: [pointScratch.x, pointScratch.y - 1.2, pointScratch.z],
      rotationY,
      capLength: half * 2,
      columnHeight: Math.max(pointScratch.y - 2.2, 1),
      columnOffsets: [-half + 3, half - 3],
    });
  }
  return descriptors;
}

/** One sample of a road's pavement, for asking "is this point on someone else's road?". */
interface PavementSample {
  x: number;
  z: number;
  y: number;
  /** Half the paved width at this point (narrowing along a taper). */
  paved: number;
  edge: Edge3D;
}
let pavementGrid = new Map<string, PavementSample[]>();

/**
 * The stretches (as [t0, t1] fractions of the edge) of a painted line or barrier at `lateralOffsetFt` that do NOT lie
 * on another road's pavement at about the same height. A ramp's edge line and barrier run on into the freeway lanes
 * it merges with; those stretches are dropped so only the part that really borders its own road is drawn.
 */
export function visibleRanges(edge: Edge3D, lateralOffsetFt: number): [number, number][] {
  if (pavementGrid.size === 0 || edge.length < 30) return [[0, 1]];
  const step = 10;
  const n = Math.max(2, Math.ceil(edge.length / step));
  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  const p = new THREE.Vector3();
  const ranges: [number, number][] = [];
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    edgePointAt(edge, t, p);
    edgeRightVectorAt(edge, t, tangent, right);
    const kv = widthScaleAt(edge, t * edge.length);
    const lateral = carriagewayOffsetAt(edge, t * edge.length, kv) + lateralOffsetFt * kv;
    const x = p.x + right.x * lateral;
    const z = p.z + right.z * lateral;
    const cx = Math.floor(x / PIER_GRID_CELL_FT);
    const cz = Math.floor(z / PIER_GRID_CELL_FT);
    let blocked = false;
    for (let dx = -1; dx <= 1 && !blocked; dx++) {
      for (let dz = -1; dz <= 1 && !blocked; dz++) {
        const arr = pavementGrid.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (const s of arr) {
          const o = s.edge;
          if (o === edge || Math.abs(s.y - p.y) > 3.5) continue;
          // the opposite carriageway of the same road borders this one; it is not "another road"
          if (o.fromNodeId === edge.toNodeId && o.toNodeId === edge.fromNodeId) continue;
          if (Math.hypot(s.x - x, s.z - z) < s.paved - 0.8) {
            blocked = true;
            break;
          }
        }
      }
    }
    if (!blocked && runStart < 0) runStart = t;
    if ((blocked || i === n) && runStart >= 0) {
      const end = blocked ? (i - 1) / n : t;
      if ((end - runStart) * edge.length > 15) ranges.push([runStart, end]);
      runStart = -1;
    }
  }
  return ranges;
}

/** Cell size (ft) of the lookup grid used to find roads running underneath a bridge. */
const PIER_GRID_CELL_FT = 60;
const PIER_SAMPLE_STEP_FT = 10;

/**
 * A bridge's piers are spaced evenly along it, which is fine over grass but puts a column in the middle of the lanes
 * wherever the bridge crosses another road. This finds every pier whose column would stand on a lower road's pavement
 * and marks it on the edge (as `pierSkips`) so it is not built: the deck simply spans the road, as a real flyover does.
 */
export function indexPierConflicts(edges: Edge3D[]): void {
  const grid = new Map<string, { x: number; z: number; y: number; half: number; edge: Edge3D }[]>();
  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  const p = new THREE.Vector3();
  const cellOf = (v: number) => Math.floor(v / PIER_GRID_CELL_FT);
  pavementGrid = new Map();

  for (const e of edges) {
    for (let d = 0; d <= e.length + 0.01; d += PIER_SAMPLE_STEP_FT) {
      const t = clamp01(d / e.length);
      edgePointAt(e, t, p);
      edgeRightVectorAt(e, t, tangent, right);
      const ke = widthScaleAt(e, d);
      const off = carriagewayOffsetAt(e, d, ke);
      const x = p.x + right.x * off;
      const z = p.z + right.z * off;
      const key = `${cellOf(x)},${cellOf(z)}`;
      const arr = grid.get(key);
      // The pavement's real half width here, shoulders and any flare or taper included.
      const half = ((e.lanes * e.laneWidthFt) / 2 + 4) * ke + 1;
      const sample = { x, z, y: p.y, half, edge: e };
      if (arr) arr.push(sample);
      else grid.set(key, [sample]);
      // The same point, for the line/barrier overlap test: paved half-width only (narrowing along a taper).
      const paved = ((e.lanes * e.laneWidthFt) / 2) * ke;
      const pave: PavementSample = { x, z, y: p.y, paved, edge: e };
      const parr = pavementGrid.get(key);
      if (parr) parr.push(pave);
      else pavementGrid.set(key, [pave]);
    }
  }

  const blockedAt = (x: number, z: number, deckY: number, self: Edge3D): boolean => {
    const cx = cellOf(x);
    const cz = cellOf(z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const arr = grid.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (const s of arr) {
          if (s.edge === self || s.y > deckY - 4.2) continue; // only roads clearly below the deck count
          if (Math.hypot(s.x - x, s.z - z) < s.half + 1.5) return true;
        }
      }
    }
    return false;
  };

  for (const e of edges) {
    e.pierSkips = undefined;
    if (!e.isElevated) continue;
    for (const d of computePierDescriptors(e, 90, true)) {
      const sinY = Math.sin(d.rotationY);
      const cosY = Math.cos(d.rotationY);
      const deckY = d.capPosition[1] + 1.2;
      const spots = [0, ...d.columnOffsets].map((off) => [d.capPosition[0] + sinY * off, d.capPosition[2] + cosY * off] as const);
      if (spots.some(([x, z]) => blockedAt(x, z, deckY, e))) {
        (e.pierSkips ??= new Set()).add(Math.round(d.distanceFt));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gore: the painted wedge between a ramp and the through road where they are close but not yet joined (or have just
// parted), as on every real merge and exit: a paved strip with diagonal white hatching.
// ---------------------------------------------------------------------------

const GORE_MAX_WIDTH_FT = 70;
/** Hatching only where the wedge is narrow enough to read as a painted gore; wider is plain paved shoulder. */
const GORE_HATCH_MAX_WIDTH_FT = 26;
const GORE_MIN_WIDTH_FT = 1.2;
const GORE_HATCH_EVERY_FT = 10;

export interface GoreGeometry {
  pave: THREE.BufferGeometry;
  hatching: THREE.BufferGeometry;
}

function goreFor(edge: Edge3D, pad: JoinPad, atEnd: boolean): GoreGeometry | null {
  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  const p = new THREE.Vector3();
  const n = pad.gap.length;
  const hr = (edge.lanes * edge.laneWidthFt) / 2;
  // The ramp's inner edge (the side facing the through road) at each sample, and the through road's edge beside it.
  const inner: ([number, number, number] | null)[] = [];
  const outer: [number, number, number][] = [];
  const width: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = i * JOIN_STEP_FT;
    const dist = atEnd ? edge.length - d : d;
    const t = Math.min(1, Math.max(0, dist / edge.length));
    edgePointAt(edge, t, p);
    edgeRightVectorAt(edge, t, tangent, right);
    const k = widthScaleAt(edge, dist);
    const lateral = carriagewayOffsetAt(edge, dist, k) - pad.awaySign * hr * k;
    const ix = p.x + right.x * lateral;
    const iz = p.z + right.z * lateral;
    const mx = pad.mainEdge[i * 3];
    const my = pad.mainEdge[i * 3 + 1];
    const mz = pad.mainEdge[i * 3 + 2];
    const w = Math.hypot(mx - ix, mz - iz);
    width.push(w);
    outer.push([mx, my, mz]);
    inner.push(w >= GORE_MIN_WIDTH_FT && w <= GORE_MAX_WIDTH_FT && Math.abs(my - p.y) < 6 ? [ix, p.y, iz] : null);
  }
  const pave: number[] = [];
  const hatch: number[] = [];
  const Y_PAVE = 0.022;
  const Y_HATCH = 0.045;
  for (let i = 0; i + 1 < n; i++) {
    const a = inner[i];
    const b = inner[i + 1];
    if (!a || !b) continue;
    const ma = outer[i];
    const mb = outer[i + 1];
    pave.push(a[0], a[1] + Y_PAVE, a[2], ma[0], ma[1] + Y_PAVE, ma[2], mb[0], mb[1] + Y_PAVE, mb[2]);
    pave.push(a[0], a[1] + Y_PAVE, a[2], mb[0], mb[1] + Y_PAVE, mb[2], b[0], b[1] + Y_PAVE, b[2]);
  }
  // Diagonal hatching: a short bar across the strip every few feet, slanted at 45 degrees along the road, so the
  // bars read as an even ladder however wide the strip is.
  for (let d = 6; d < (n - 1) * JOIN_STEP_FT; d += GORE_HATCH_EVERY_FT) {
    const i = Math.floor(d / JOIN_STEP_FT);
    const a = inner[i];
    if (!a || i + 1 >= n || width[i] < 2 || width[i] > GORE_HATCH_MAX_WIDTH_FT) continue;
    const m = outer[i];
    const ax = m[0] - a[0];
    const az = m[2] - a[2];
    const w = Math.hypot(ax, az) || 1;
    // the road's own direction here, from this sample to the next
    const mn = outer[i + 1];
    const rx = mn[0] - m[0];
    const rz = mn[2] - m[2];
    const rl = Math.hypot(rx, rz) || 1;
    const ex = m[0] + (rx / rl) * w * 0.9;
    const ez = m[2] + (rz / rl) * w * 0.9;
    const dx = ex - a[0];
    const dz = ez - a[2];
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const hw = 0.85;
    hatch.push(a[0] + nx * hw, a[1] + Y_HATCH, a[2] + nz * hw, a[0] - nx * hw, a[1] + Y_HATCH, a[2] - nz * hw, ex - nx * hw, m[1] + Y_HATCH, ez - nz * hw);
    hatch.push(a[0] + nx * hw, a[1] + Y_HATCH, a[2] + nz * hw, ex - nx * hw, m[1] + Y_HATCH, ez - nz * hw, ex + nx * hw, m[1] + Y_HATCH, ez + nz * hw);
  }
  if (pave.length === 0) return null;
  const make = (pos: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(faceUp(pos), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  return { pave: make(pave), hatching: make(hatch.length ? hatch : [0, -50, 0, 0, -50, 0, 0, -50, 0]) };
}

/** Gore strips for the ends of this road that merge into or split from a bigger one. */
export function buildGores(edge: Edge3D): GoreGeometry[] {
  const out: GoreGeometry[] = [];
  if (edge.padStart) {
    const g = goreFor(edge, edge.padStart, false);
    if (g) out.push(g);
  }
  if (edge.padEnd) {
    const g = goreFor(edge, edge.padEnd, true);
    if (g) out.push(g);
  }
  return out;
}

/** Reorders each triangle so it faces up, whichever way round its corners were given (one-sided materials cull the rest). */
function faceUp(pos: number[]): number[] {
  const out = pos.slice();
  for (let i = 0; i + 8 < out.length; i += 9) {
    const ux = out[i + 3] - out[i], uz = out[i + 5] - out[i + 2];
    const vx = out[i + 6] - out[i], vz = out[i + 8] - out[i + 2];
    // y component of (u x v): negative means the triangle faces down
    if (uz * vx - ux * vz < 0) {
      for (let k = 0; k < 3; k++) {
        const t = out[i + 3 + k];
        out[i + 3 + k] = out[i + 6 + k];
        out[i + 6 + k] = t;
      }
    }
  }
  return out;
}

/** The two outer corners of a road's pavement where it begins (or ends), exactly where its asphalt ribbon is cut. */
function endCorners(edge: Edge3D, atEnd: boolean): [THREE.Vector3, THREE.Vector3] {
  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  const p = new THREE.Vector3();
  const t = atEnd ? 1 : 0;
  const dist = atEnd ? edge.length : 0;
  edgePointAt(edge, t, p);
  edgeRightVectorAt(edge, t, tangent, right);
  const k = widthScaleAt(edge, dist);
  const half = ((edge.lanes * edge.laneWidthFt) / 2 + 4) * k;
  const centre = carriagewayOffsetAt(edge, dist, k);
  const lift = !edge.sunken && p.y < 0 ? -p.y : 0;
  const at = (lateral: number) => p.clone().addScaledVector(right, lateral).add(new THREE.Vector3(0, lift, 0));
  return [at(centre - half), at(centre + half)];
}

/** Roads whose headings differ by no more than this at a node are one road splitting or joining, not a crossing. */
const FILL_MAX_ANGLE_RAD = (50 * Math.PI) / 180;

/**
 * Where a road splits in two (an exit) or two roads join (a merge), the pavements of the roads involved are cut square
 * and leave a triangle of bare ground at the nose. This returns asphalt that fills that triangle: the convex outline of
 * the pavement corners of every road in the group at the node.
 */
export function buildJunctionFills(edges: Edge3D[]): THREE.BufferGeometry | null {
  // A roundabout's own pavement is the junction: filling the hull of the arms that meet it only drops dark slabs on the ring.
  const ringNodes = new Set<string>();
  for (const e of edges) if (e.isRoundaboutRing) (ringNodes.add(e.fromNodeId), ringNodes.add(e.toNodeId));
  const inBy = new Map<string, Edge3D[]>();
  const outBy = new Map<string, Edge3D[]>();
  for (const e of edges) {
    if (e.isRoundaboutRing || e.isTexasTurnaround) continue;
    (inBy.get(e.toNodeId) ?? inBy.set(e.toNodeId, []).get(e.toNodeId)!).push(e);
    (outBy.get(e.fromNodeId) ?? outBy.set(e.fromNodeId, []).get(e.fromNodeId)!).push(e);
  }
  const tIn = new THREE.Vector3();
  const tOut = new THREE.Vector3();
  const positions: number[] = [];
  for (const [nodeId, ins] of inBy) {
    if (ringNodes.has(nodeId)) continue;
    const outs = outBy.get(nodeId);
    if (!outs) continue;
    // Pair up roads that carry on along one line of travel, then group the pairs that share a road.
    const parent = new Map<Edge3D, Edge3D>();
    const find = (e: Edge3D): Edge3D => {
      let r = e;
      while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const used = new Set<Edge3D>();
    for (const i of ins) {
      i.spline.getTangentAt(1, tIn);
      for (const o of outs) {
        if (o.toNodeId === i.fromNodeId) continue;
        o.spline.getTangentAt(0, tOut);
        const la = Math.hypot(tIn.x, tIn.z) || 1;
        const lb = Math.hypot(tOut.x, tOut.z) || 1;
        const ang = Math.acos(Math.max(-1, Math.min(1, (tIn.x * tOut.x + tIn.z * tOut.z) / (la * lb))));
        if (ang > FILL_MAX_ANGLE_RAD) continue;
        if (Math.abs(i.spline.getPointAt(1).y - o.spline.getPointAt(0).y) > 3) continue;
        for (const e of [i, o]) if (!parent.has(e)) parent.set(e, e);
        parent.set(find(i), find(o));
        used.add(i);
        used.add(o);
      }
    }
    const groups = new Map<Edge3D, Edge3D[]>();
    for (const e of used) {
      const root = find(e);
      (groups.get(root) ?? groups.set(root, []).get(root)!).push(e);
    }
    for (const members of groups.values()) {
      if (members.length < 3) {
        // A plain one-to-one continuation has no nose, but where it bends the square-cut ends leave a wedge of bare
        // ground on the outside of the bend.
        const into = members.find((m) => m.toNodeId === nodeId);
        const out = members.find((m) => m.fromNodeId === nodeId);
        if (!into || !out) continue;
        into.spline.getTangentAt(1, tIn);
        out.spline.getTangentAt(0, tOut);
        const la = Math.hypot(tIn.x, tIn.z) || 1;
        const lb = Math.hypot(tOut.x, tOut.z) || 1;
        const bend = Math.acos(Math.max(-1, Math.min(1, (tIn.x * tOut.x + tIn.z * tOut.z) / (la * lb))));
        if (bend < (3 * Math.PI) / 180) continue;
      }
      const pts: THREE.Vector3[] = [];
      for (const e of members) {
        const [l, r] = endCorners(e, e.toNodeId === nodeId);
        pts.push(l, r);
      }
      const hull = convexHullXZ(pts);
      if (hull.length < 3) continue;
      for (let k = 1; k + 1 < hull.length; k++) {
        for (const v of [hull[0], hull[k], hull[k + 1]]) positions.push(v.x, v.y + 0.01, v.z);
      }
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(faceUp(positions), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Convex outline of points in the ground plane, in order (Andrew's monotone chain). */
function convexHullXZ(points: THREE.Vector3[]): THREE.Vector3[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: THREE.Vector3[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: THREE.Vector3[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
