/**
 * Road grade (rise/run), computed straight from node elevation — which is
 * already baked into `NodeSpec.position[1]` at creation time by the
 * selected elevation preset, so no separate terrain/heightmap model is
 * needed to know how steep a segment really is.
 */

/** Horizontal (x/z-plane) distance between two points, in feet — ignores elevation. */
export function horizontalDistanceFt(a: [number, number, number], b: [number, number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dz * dz);
}

/** Standard highway-design maximum sustained grade, used as the hard limit in the Mountain Cut scenario. */
export const MAX_GRADE_PERCENT = 6;

/** Grade as a percentage (rise/run x 100), positive = uphill from a to b. */
export function computeGradePercent(a: [number, number, number], b: [number, number, number]): number {
  const run = horizontalDistanceFt(a, b);
  if (run < 1e-6) return 0;
  const rise = b[1] - a[1];
  return (rise / run) * 100;
}
