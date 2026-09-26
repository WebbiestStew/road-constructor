/**
 * Intelligent Driver Model (IDM) and MOBIL lane-changing model.
 *
 * All quantities are in Imperial units internally: feet, feet/second,
 * feet/second^2, seconds. This module is pure math with no allocations in
 * its hot paths so it can be called thousands of times per simulation tick
 * without generating garbage.
 *
 * References:
 *  - Treiber, Hennecke & Helbing (2000), "Congested Traffic States in
 *    Empirical Observations and Microscopic Simulations"
 *  - Kesting, Treiber & Helbing (2007), "General Lane-Changing Model MOBIL"
 */

export interface IDMParams {
  /** Maximum comfortable acceleration, ft/s^2. */
  a: number;
  /** Comfortable (desired) braking deceleration, ft/s^2. */
  b: number;
  /** Jam distance: minimum bumper-to-bumper gap at a standstill, ft. */
  s0: number;
  /** Desired time headway, s. */
  T: number;
  /** Free-flow / desired speed, ft/s. */
  v0: number;
  /** Acceleration exponent. */
  delta: number;
}

export const IDM_DEFAULTS: IDMParams = {
  a: 4.5,
  b: 6.5,
  s0: 6.5,
  T: 1.4,
  v0: 88, // 60 mph
  delta: 4,
};

export interface MOBILParams {
  /** Politeness factor p in [0,1]; 0 = purely selfish, 1 = fully altruistic. */
  politeness: number;
  /** Minimum acceleration advantage (ft/s^2) required to trigger a lane change. */
  changeThreshold: number;
  /** Maximum deceleration (ft/s^2, positive value) the MOBIL safety criterion allows imposing on the new follower. */
  bSafe: number;
  /** Small acceleration bias (ft/s^2) rewarding staying in / moving toward the right lane. */
  rightLaneBias: number;
}

export const MOBIL_DEFAULTS: MOBILParams = {
  politeness: 0.3,
  changeThreshold: 0.25,
  bSafe: 13.0,
  rightLaneBias: 0.15,
};

/** A very large effective gap used to represent "no leader" without using Infinity (keeps math finite). */
export const NO_LEADER_GAP = 1e5;

/**
 * Core IDM acceleration.
 *
 * @param v current speed, ft/s
 * @param gap net bumper-to-bumper distance to the vehicle ahead, ft (clamped to a small positive minimum)
 * @param deltaV closing speed = v - vLeader, ft/s (positive = approaching)
 * @param v0 desired speed for this driver on this road, ft/s (already min'd with speed limit upstream)
 * @param params model constants
 */
export function idmAccel(
  v: number,
  gap: number,
  deltaV: number,
  v0: number,
  params: IDMParams = IDM_DEFAULTS
): number {
  const { a, b, s0, T, delta } = params;
  const safeGap = gap > 0.1 ? gap : 0.1;
  const freeRoadTerm = Math.pow(Math.max(v, 0) / Math.max(v0, 0.1), delta);
  const interactionDistance =
    s0 + Math.max(0, v * T + (v * deltaV) / (2 * Math.sqrt(a * b)));
  const decelTerm = (interactionDistance / safeGap) * (interactionDistance / safeGap);
  return a * (1 - freeRoadTerm - decelTerm);
}

/**
 * Convenience wrapper for the "no leader within sensor range" case.
 */
export function idmAccelFreeRoad(
  v: number,
  v0: number,
  params: IDMParams = IDM_DEFAULTS
): number {
  return idmAccel(v, NO_LEADER_GAP, 0, v0, params);
}

/**
 * "Approaching a hard stop" helper — used when a vehicle must be treated as
 * decelerating toward a fixed point (e.g. end of a dead-end edge with no
 * successor yet assigned), modeled as a stationary phantom leader at
 * distance `distanceToStop`.
 */
export function idmAccelTowardStop(
  v: number,
  distanceToStop: number,
  v0: number,
  params: IDMParams = IDM_DEFAULTS
): number {
  return idmAccel(v, distanceToStop, v, v0, params);
}

export interface MobilInputs {
  /** Acceleration the vehicle currently experiences in its present lane. */
  currentAccel: number;
  /** Acceleration the vehicle would experience if it moved to the target lane right now. */
  targetLaneAccel: number;
  /** Current follower's acceleration if the ego vehicle stays put. */
  oldFollowerAccelBefore: number;
  /** Current follower's acceleration after the ego vehicle vacates the lane. */
  oldFollowerAccelAfter: number;
  /** Target lane follower's acceleration before the ego vehicle merges in. */
  newFollowerAccelBefore: number;
  /** Target lane follower's acceleration after the ego vehicle merges in. */
  newFollowerAccelAfter: number;
  /** +1 if the candidate lane is to the right (bias favors this), -1 if left, 0 if neutral. */
  laneBiasDirection: -1 | 0 | 1;
}

export interface MobilResult {
  shouldChange: boolean;
  incentive: number;
}

/**
 * Evaluates the MOBIL safety + incentive criteria for a single candidate
 * lane change.
 *
 * Safety criterion: the new follower must not be forced to brake harder
 * than `bSafe`.
 *
 * Incentive criterion: the ego vehicle's own acceleration gain, minus a
 * politeness-weighted sum of the disadvantage imposed on the old and new
 * followers, must exceed `changeThreshold`.
 */
export function mobilEvaluate(
  inputs: MobilInputs,
  params: MOBILParams = MOBIL_DEFAULTS
): MobilResult {
  const { politeness, changeThreshold, bSafe, rightLaneBias } = params;

  if (inputs.newFollowerAccelAfter < -bSafe) {
    return { shouldChange: false, incentive: -Infinity };
  }

  const selfAdvantage = inputs.targetLaneAccel - inputs.currentAccel;
  const oldFollowerDisadvantage =
    inputs.oldFollowerAccelBefore - inputs.oldFollowerAccelAfter;
  const newFollowerDisadvantage =
    inputs.newFollowerAccelBefore - inputs.newFollowerAccelAfter;

  const bias = inputs.laneBiasDirection * rightLaneBias;

  const incentive =
    selfAdvantage +
    bias -
    politeness * (oldFollowerDisadvantage + newFollowerDisadvantage);

  return { shouldChange: incentive > changeThreshold, incentive };
}

/** Clamp a value between [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
