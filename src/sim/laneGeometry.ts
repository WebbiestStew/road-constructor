import * as THREE from "three";
import { JOIN_STEP_FT, type Edge3D, type JoinPad } from "./types";

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


// ---------------------------------------------------------------------------
// Fast sampling. The simulation asks for a position and heading for every vehicle many times a tick, and the spline's
// own getPointAt/getTangentAt (arc-length lookup, then curve evaluation) was about a third of all simulation time.
// Each road gets a table of points and headings at fixed arc-length steps, built once on first use, and lookups
// interpolate between its entries. At this spacing the sag of a chord on any real curve is a couple of inches.
// ---------------------------------------------------------------------------

const LUT_STEP_FT = 3;
interface EdgeLut {
  n: number;
  pos: Float64Array;
  tan: Float64Array;
}
const luts = new WeakMap<Edge3D, EdgeLut>();

function lutFor(edge: Edge3D): EdgeLut {
  let lut = luts.get(edge);
  if (lut) return lut;
  const n = Math.max(2, Math.min(6000, Math.ceil(edge.length / LUT_STEP_FT)));
  const pos = new Float64Array((n + 1) * 3);
  const tan = new Float64Array((n + 1) * 3);
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    edge.spline.getPointAt(i / n, p);
    edge.spline.getTangentAt(i / n, t);
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    tan[i * 3] = t.x;
    tan[i * 3 + 1] = t.y;
    tan[i * 3 + 2] = t.z;
  }
  lut = { n, pos, tan };
  luts.set(edge, lut);
  return lut;
}

/** Same as `edgePointAt`, from the road's lookup table. */
export function fastPointAt(edge: Edge3D, t: number, out: THREE.Vector3): THREE.Vector3 {
  const lut = lutFor(edge);
  const f = clampT(t) * lut.n;
  const i = f >= lut.n ? lut.n - 1 : Math.floor(f);
  const w = f - i;
  const a = i * 3;
  const b = a + 3;
  out.set(
    lut.pos[a] + (lut.pos[b] - lut.pos[a]) * w,
    lut.pos[a + 1] + (lut.pos[b + 1] - lut.pos[a + 1]) * w,
    lut.pos[a + 2] + (lut.pos[b + 2] - lut.pos[a + 2]) * w
  );
  return out;
}

/** Same as `edgeTangentAt` (a unit vector), from the road's lookup table. */
export function fastTangentAt(edge: Edge3D, t: number, out: THREE.Vector3): THREE.Vector3 {
  const lut = lutFor(edge);
  const f = clampT(t) * lut.n;
  const i = f >= lut.n ? lut.n - 1 : Math.floor(f);
  const w = f - i;
  const a = i * 3;
  const b = a + 3;
  out.set(
    lut.tan[a] + (lut.tan[b] - lut.tan[a]) * w,
    lut.tan[a + 1] + (lut.tan[b + 1] - lut.tan[a + 1]) * w,
    lut.tan[a + 2] + (lut.tan[b + 2] - lut.tan[a + 2]) * w
  );
  const len = out.length();
  if (len > 1e-9) out.multiplyScalar(1 / len);
  return out;
}

function fastRightVectorAt(edge: Edge3D, t: number, tangentScratch: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  fastTangentAt(edge, t, tangentScratch);
  out.crossVectors(tangentScratch, _upVector);
  if (out.lengthSq() < 1e-8) out.set(1, 0, 0);
  else out.normalize();
  return out;
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


/** 1 along most of a road; shrinks toward the node over a merge or diverge taper so pavement and lanes close in together. */
export function widthScaleAt(edge: Edge3D, distanceFt: number): number {
  let k = 1;
  // A ramp merging into or splitting from a through road tapers to a point; a funnel into a roundabout only narrows.
  if (edge.taperStartFt > 0 && distanceFt < edge.taperStartFt) {
    k = Math.min(k, edge.startScale + (1 - edge.startScale) * smooth01(distanceFt / edge.taperStartFt));
  }
  const toEnd = edge.length - distanceFt;
  if (edge.taperEndFt > 0 && toEnd < edge.taperEndFt) {
    k = Math.min(k, edge.endScale + (1 - edge.endScale) * smooth01(toEnd / edge.taperEndFt));
  }
  return k;
}

/** Smooth "keep at least this far out": zero when not needed, then ramps in without a corner. */
/** The strip left between a ramp and the road it rides alongside, once the ramp has been drawn in. */
const JOIN_PULL_GAP_FT = 6;
/** Fraction of the measured stretch (from the junction) over which the ramp is held fully against the road. */
const JOIN_PULL_HOLD = 0.35;
/** How fast the strip beside the through road may widen, in feet of gap per foot along the road (about 6 degrees). */
const JOIN_PULL_SPLAY = 0.1;

function softPush(x: number): number {
  if (x <= 0) return 0;
  return x < 2 ? (x * x) / 4 : x - 1;
}

function padPush(pad: JoinPad, distance: number, k: number, hr: number): number {
  // rounding can leave a hair below zero at the very end of a road, which would index before the first sample
  const d = Math.max(0, distance);
  if (d >= pad.reach) return 0;
  const f = d / JOIN_STEP_FT;
  const i = Math.floor(f);
  const g = pad.gap[i] + (pad.gap[Math.min(i + 1, pad.gap.length - 1)] - pad.gap[i]) * (f - i);
  // Push the ramp outward just far enough that its inner edge sits against the through road's outer edge,
  // instead of lying across the through road's lanes.
  const clear = g - pad.mainHalf - k * hr;
  // Where the ramp has drifted off from the through road, draw it in toward the road so the strip between them is a
  // narrow gore rather than a long wedge of grass. The strip is allowed to widen only gently with distance from the
  // junction, so the ramp converges along a steady line instead of swinging in and back out. The pull fades out at
  // the end of the measured stretch, where the ramp is back on its own line.
  const cap = JOIN_PULL_GAP_FT + JOIN_PULL_SPLAY * d;
  const fade = 1 - smooth01((d / pad.reach - JOIN_PULL_HOLD) / (1 - JOIN_PULL_HOLD));
  const pull = Math.max(0, clear - cap) * fade;
  // A ramp still lying on the through road where the measured stretch ends (a short stub) is eased back to its own
  // line over the last part of that stretch, rather than snapping across it.
  const release = 1 - smooth01((d / pad.reach - 0.6) / 0.4);
  return pad.awaySign * (softPush(0.5 - clear) * release - pull);
}

/**
 * Extra sideways shift of a road that rides alongside a bigger one at a merge or split, in feet along its own right
 * vector. `k` is the width scale at this point, so the shifted pavement's inner edge still tracks the through road.
 */
export function joinShiftAt(edge: Edge3D, distanceFt: number, k: number): number {
  if (!edge.padStart && !edge.padEnd) return 0;
  const hr = (edge.lanes * edge.laneWidthFt) / 2;
  let a = 0;
  let b = 0;
  if (edge.padStart) a = padPush(edge.padStart, distanceFt, k, hr);
  if (edge.padEnd) b = padPush(edge.padEnd, edge.length - distanceFt, k, hr);
  return Math.abs(a) >= Math.abs(b) ? a : b;
}

/**
 * Where the centreline of this carriageway really lies sideways at `distanceFt`: its shift to its own side of a
 * two-way road, plus any push out along a merge or split. Offsets of lanes and lines are added to this after being
 * scaled by `widthScaleAt`.
 */
export function carriagewayOffsetAt(edge: Edge3D, distanceFt: number, k: number): number {
  return lateralShiftAt(edge, distanceFt) + joinShiftAt(edge, distanceFt, k);
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
  fastPointAt(edge, ct, out);
  fastRightVectorAt(edge, ct, tangentScratch, rightScratch);
  const d = ct * edge.length;
  const k = widthScaleAt(edge, d);
  const offset = laneOffsetFt(laneIndex, edge.lanes, edge.laneWidthFt) * k + carriagewayOffsetAt(edge, d, k);
  out.addScaledVector(rightScratch, offset);
  if (!edge.sunken && out.y < 0) out.y = 0;
  return out;
}

/** Converts an arc-length distance along an edge into the curve's normalized [0,1] parameter. */
export function distanceToT(edge: Edge3D, distanceFt: number): number {
  const clamped = distanceFt <= 0 ? 0 : distanceFt >= edge.length ? edge.length : distanceFt;
  return edge.length > 0 ? clamped / edge.length : 0;
}
