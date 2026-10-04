import * as THREE from "three";
import { fastTangentAt } from "./laneGeometry";
import type { Edge3D, LaneMove, SignalControl } from "./types";

/**
 * Signal phasing. A signal runs a repeating plan of phases; in each, some movements from some approaches have a green
 * and everything else is red, with a short all-red clearance between phases.
 *
 *   "two"       the classic plan: one phase for the approaches in group A, one for group B. Left turns go with the
 *               through traffic (and yield to oncoming cars where the level says left turns give way).
 *   "protected" each group gets a left-turn phase first (only the left turns, so they cross unopposed) and then a
 *               through-and-right phase with the left turns held back.
 *   "split"     every approach gets a phase to itself, so nothing ever conflicts, at the price of a longer cycle.
 *
 * Either plan can add a pedestrian phase: everything red for a while so people can cross.
 */
export type SignalMode = "two" | "protected" | "split";

export const DEFAULT_LEFT_GREEN_S = 8;
export const MAX_PED_PHASE_S = 25;

const BIT: Record<LaneMove, number> = { left: 1, straight: 2, right: 4 };
const ALL = 7;

export interface PhaseDef {
  durationS: number;
  /** For each approach with a green in this phase, which moves (bit set) may go. */
  allow: Map<string, number>;
  /** True while left turns that are allowed also give way to oncoming traffic (only the classic plan). */
  permissive: boolean;
  /** A phase with every approach red, for people to cross. */
  pedestrian: boolean;
  label: string;
}

export interface SignalPlan {
  phases: PhaseDef[];
  /** All-red between phases. */
  clearS: number;
  cycleS: number;
  /** Every approach this signal controls. An approach it doesn't list is not stopped by it. */
  controlled: Set<string>;
}

/** What the plan needs to know about an approach: the moves it can make at the junction, and its heading in the plane. */
export interface ApproachInfo {
  moves: ReadonlySet<LaneMove>;
  hx: number;
  hz: number;
}

const _tangent = new THREE.Vector3();
/** An approach's moves and heading, read from the assembled road. */
export function infoFromEdge(edge: Edge3D): ApproachInfo {
  fastTangentAt(edge, 1, _tangent);
  return { moves: new Set(edge.nextMoves.values()), hx: _tangent.x, hz: _tangent.z };
}

export function modeOf(control: SignalControl): SignalMode {
  return control.mode ?? "two";
}

export function allows(plan: SignalPlan, phase: number, edgeId: string, move: LaneMove): boolean {
  return ((plan.phases[phase]?.allow.get(edgeId) ?? 0) & BIT[move]) !== 0;
}

/** Splits a group's approaches into the two directions they arrive from. */
function halves(ids: string[], info: (id: string) => ApproachInfo | null): string[][] {
  if (ids.length === 0) return [];
  const ref = info(ids[0]);
  if (!ref) return [ids];
  const first: string[] = [];
  const second: string[] = [];
  for (const id of ids) {
    const a = info(id);
    if (!a || a.hx * ref.hx + a.hz * ref.hz >= 0) first.push(id);
    else second.push(id);
  }
  return second.length > 0 ? [first, second] : [first];
}

export function buildSignalPlan(control: SignalControl, info: (id: string) => ApproachInfo | null): SignalPlan {
  const g = control.greenDurationS;
  const clearS = control.allRedDurationS;
  const phases: PhaseDef[] = [];
  const groups: [string, string[]][] = [
    ["A", control.groupA],
    ["B", control.groupB],
  ];
  const mode = modeOf(control);
  const all = (ids: string[]) => new Map(ids.map((id) => [id, ALL]));

  if (mode === "two") {
    for (const [name, ids] of groups) phases.push({ durationS: g, allow: all(ids), permissive: true, pedestrian: false, label: `${name}: all movements` });
  } else if (mode === "protected") {
    for (const [name, ids] of groups) {
      if (ids.length === 0) continue;
      const lefters = ids.filter((id) => info(id)?.moves.has("left"));
      if (lefters.length > 0) {
        phases.push({
          durationS: Math.max(3, control.leftGreenS ?? DEFAULT_LEFT_GREEN_S),
          allow: new Map(lefters.map((id) => [id, BIT.left])),
          permissive: false,
          pedestrian: false,
          label: `${name}: left turns`,
        });
        phases.push({
          durationS: g,
          allow: new Map(ids.map((id) => [id, BIT.straight | BIT.right])),
          permissive: false,
          pedestrian: false,
          label: `${name}: through and right`,
        });
      } else {
        phases.push({ durationS: g, allow: all(ids), permissive: true, pedestrian: false, label: `${name}: all movements` });
      }
    }
  } else {
    for (const [name, ids] of groups) {
      halves(ids, info).forEach((half, i) => phases.push({ durationS: g, allow: all(half), permissive: false, pedestrian: false, label: `${name}${i + 1}: one approach` }));
    }
  }

  const ped = Math.max(0, Math.min(MAX_PED_PHASE_S, Math.round(control.pedPhaseS ?? 0)));
  if (ped > 0 && phases.length > 0) phases.push({ durationS: ped, allow: new Map(), permissive: false, pedestrian: true, label: "Pedestrians cross" });

  const controlled = new Set<string>([...control.groupA, ...control.groupB]);
  const cycleS = phases.reduce((n, p) => n + p.durationS + clearS, 0);
  return { phases, clearS, cycleS, controlled };
}

/** The plan's cycle length without a network to ask, for the offset slider: the classic plan exactly, the others as if every group has left turns. */
export function approxCycleS(control: SignalControl): number {
  const g = control.greenDurationS;
  const r = control.allRedDurationS;
  const mode = modeOf(control);
  const ped = Math.max(0, Math.round(control.pedPhaseS ?? 0));
  let phases = 2;
  let seconds = 2 * g;
  if (mode === "protected") {
    phases = 4;
    seconds = 2 * g + 2 * Math.max(3, control.leftGreenS ?? DEFAULT_LEFT_GREEN_S);
  } else if (mode === "split") {
    phases = 4;
    seconds = 4 * g;
  }
  if (ped > 0) {
    phases += 1;
    seconds += ped;
  }
  return seconds + phases * r;
}

/** Where in its cycle a plan starts, given an offset: the phase it is in, whether that is the clearance after it, and the time into that stretch. */
export function startOfCycle(plan: SignalPlan, offsetS: number): { index: number; clearing: boolean; timer: number } {
  const cycle = plan.cycleS;
  let t = cycle > 0 ? (((offsetS % cycle) + cycle) % cycle) : 0;
  for (let i = 0; i < plan.phases.length; i++) {
    const d = plan.phases[i].durationS;
    if (t < d) return { index: i, clearing: false, timer: t };
    t -= d;
    if (t < plan.clearS) return { index: i, clearing: true, timer: t };
    t -= plan.clearS;
  }
  return { index: 0, clearing: false, timer: 0 };
}
