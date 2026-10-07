import * as THREE from "three";
import {
  ROAD_CLASSES,
  ROUNDABOUT_PRIORITY,
  TEXAS_TURNAROUND_MIN_RADIUS_FT,
  TEXAS_TURNAROUND_PRIORITY,
  TEXAS_TURNAROUND_SEARCH_RADIUS_FT,
} from "./roadClasses";
import { JOIN_STEP_FT, mphToFtps } from "./types";
import type {
  Edge3D,
  JoinPad,
  EdgePatch,
  EdgeSpec,
  LaneMove,
  NetworkSnapshot,
  NodeSpec,
  RoadNetwork,
} from "./types";

const ELEVATION_SAMPLE_STEPS = 16;
const ELEVATION_THRESHOLD_FT = 1;

/** A brand-new, empty buildable network — the sandbox starting state. */
export function createEmptyNetworkSnapshot(): NetworkSnapshot {
  return { nodes: [], edges: [] };
}

/** Points a plain node-to-node ramp is subdivided into so its elevation can ease in/out instead of jumping to a new grade in one straight line. */
const VERTICAL_CURVE_STEPS = 6;
/** Elevation delta (ft) below which a straight segment reads as flat enough that a vertical curve would be pointless. */
const VERTICAL_CURVE_THRESHOLD_FT = 0.5;

/** Builds a `nodeId -> distinct neighbor node ids` map from every edge's endpoints, direction-agnostic (a two-way pair of edges between the same two nodes still counts as one neighbor). Used to tell a plain "bend point" mid-road (exactly one neighbor on each side) apart from a dead end or a real multi-way junction, which should keep a straight, unsmoothed approach. */
function buildNeighborsByNode(edges: EdgeSpec[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = map.get(a);
    if (!set) {
      set = new Set();
      map.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    link(e.fromNodeId, e.toNodeId);
    link(e.toNodeId, e.fromNodeId);
  }
  return map;
}

/** If `nodeId` has exactly one neighbor other than `exclude`, returns that neighbor's id — otherwise null (a dead end, or a real junction with no single unambiguous "through" direction). */
function singleOtherNeighbor(
  neighborsByNode: Map<string, Set<string>>,
  nodeId: string,
  exclude: string
): string | null {
  const neighbors = neighborsByNode.get(nodeId);
  if (!neighbors || neighbors.size !== 2) return null;
  for (const id of neighbors) {
    if (id !== exclude) return id;
  }
  return null;
}

/** Roads closer than this in heading at a node are one road joining or leaving another, not a crossing. */
const MERGE_MAX_ANGLE_RAD = (50 * Math.PI) / 180;
const MERGE_TAPER_FT = 170;
/** A ramp tapers all the way to a tip where it meets the through road. */
const RAMP_TIP = 0.03;
/** Where a road continues into a narrower or wider one, its pavement eases between the two widths over this stretch. */
const WIDTH_BLEND_FT = 130;
/** A road that meets a wider one at a junction flares out to it over this stretch, up to this many times its own width. */
const WIDTH_FLARE_FT = 60;
const MAX_FLARE = 2.5;
/** Steepest a pavement edge may close in or open out, in feet sideways per foot along the road (about 12 degrees). */
const MAX_EDGE_SLOPE = 0.22;
/** A road shorter than this isn't flared; it just meets the wider one. */
const MIN_FLARE_ROAD_FT = 70;
/** The most a pavement may close in over `taperFt`, so a short ramp stub tapers to a narrow tip, not a needle. */
function limitNarrowing(scale: number, taperFt: number, e: Edge3D): number {
  const half = (e.lanes * e.laneWidthFt) / 2 + 4;
  return Math.max(scale, 1 - (MAX_EDGE_SLOPE * taperFt) / half);
}
/** The most a pavement may open out over `taperFt`. */
function limitFlare(scale: number, taperFt: number, e: Edge3D): number {
  const half = (e.lanes * e.laneWidthFt) / 2 + 4;
  return Math.min(scale, 1 + (MAX_EDGE_SLOPE * taperFt) / half);
}
/** How far from the junction a join pad is measured. */
const JOIN_REACH_FT = 760;

/**
 * Finds the ends where one road merges into, or splits off, another along the same line of travel (a ramp joining a
 * freeway, an exit leaving it) and marks the smaller road to taper there. The biggest road of the group (highest class,
 * then most lanes, then straightest) keeps its full width; the others narrow toward their centreline over the last
 * stretch, so the pavement blends in rather than ending in a blunt slab lying across the main road's lanes.
 */
function classifyMergesAndDiverges(edges: Edge3D[]): void {
  const tIn = new THREE.Vector3();
  const tOut = new THREE.Vector3();
  const angleBetween = (a: THREE.Vector3, b: THREE.Vector3) => {
    const la = Math.hypot(a.x, a.z) || 1;
    const lb = Math.hypot(b.x, b.z) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.z * b.z) / (la * lb))));
  };
  const inByNode = new Map<string, Edge3D[]>();
  const outByNode = new Map<string, Edge3D[]>();
  for (const e of edges) {
    if (e.isRoundaboutRing || e.isTexasTurnaround) continue;
    (inByNode.get(e.toNodeId) ?? inByNode.set(e.toNodeId, []).get(e.toNodeId)!).push(e);
    (outByNode.get(e.fromNodeId) ?? outByNode.set(e.fromNodeId, []).get(e.fromNodeId)!).push(e);
  }
  /**
   * Measures how `ramp` sits against `main` at the junction, from the ramp's end (`atEnd`) outward: the lateral
   * distance between their centrelines, which side of main it is on, and where main's outer edge runs.
   */
  const buildPad = (ramp: Edge3D, main: Edge3D, atEnd: boolean): JoinPad | undefined => {
    if (ramp.length < 60 || main.length < 40) return undefined;
    const reach = Math.min(JOIN_REACH_FT, ramp.length * 0.6);
    const mainFromEnd = main.toNodeId === (atEnd ? ramp.toNodeId : ramp.fromNodeId);
    // Sample the through road near the junction (its end if it arrives there, its start if it leaves).
    const ms: { x: number; y: number; z: number; rx: number; rz: number }[] = [];
    const mreach = Math.min(JOIN_REACH_FT * 1.4, main.length);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let d = 0; d <= mreach; d += 8) {
      const dist = mainFromEnd ? main.length - d : d;
      main.spline.getPointAt(Math.min(1, Math.max(0, dist / main.length)), p);
      main.spline.getTangentAt(Math.min(1, Math.max(0, dist / main.length)), t);
      const len = Math.hypot(t.x, t.z) || 1;
      const rx = -t.z / len;
      const rz = t.x / len;
      ms.push({ x: p.x + rx * main.lateralShiftFt, y: p.y, z: p.z + rz * main.lateralShiftFt, rx, rz });
    }
    const mainHalf = (main.lanes * main.laneWidthFt) / 2;
    const n = Math.floor(reach / JOIN_STEP_FT) + 1;
    const gap: number[] = [];
    const mainEdge: number[] = [];
    let sideSum = 0;
    let awayDotSum = 0;
    const raw: { u: number; mi: number }[] = [];
    for (let i = 0; i < n; i++) {
      const d = i * JOIN_STEP_FT;
      const dist = atEnd ? ramp.length - d : d;
      const tt = Math.min(1, Math.max(0, dist / ramp.length));
      ramp.spline.getPointAt(tt, p);
      ramp.spline.getTangentAt(tt, t);
      const len = Math.hypot(t.x, t.z) || 1;
      const rrx = -t.z / len;
      const rrz = t.x / len;
      const cx = p.x + rrx * ramp.lateralShiftFt;
      const cz = p.z + rrz * ramp.lateralShiftFt;
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < ms.length; k++) {
        const dd = (ms[k].x - cx) ** 2 + (ms[k].z - cz) ** 2;
        if (dd < bd) {
          bd = dd;
          best = k;
        }
      }
      const m = ms[best];
      const u = (cx - m.x) * m.rx + (cz - m.z) * m.rz;
      raw.push({ u, mi: best });
      if (d >= 60 && d <= 260) {
        sideSum += Math.sign(u) * Math.min(Math.abs(u), 80);
        awayDotSum += (cx - m.x) * rrx + (cz - m.z) * rrz;
      }
    }
    const side: 1 | -1 = sideSum >= 0 ? 1 : -1;
    const away: 1 | -1 = awayDotSum >= 0 ? 1 : -1;
    let adjacentUntil = 0;
    const hr = (ramp.lanes * ramp.laneWidthFt) / 2;
    for (let i = 0; i < n; i++) {
      const m = ms[raw[i].mi];
      const g = Math.max(0, raw[i].u * side);
      gap.push(g);
      mainEdge.push(m.x + m.rx * side * mainHalf, m.y, m.z + m.rz * side * mainHalf);
      if (g < mainHalf + hr + 2) adjacentUntil = i * JOIN_STEP_FT;
      if (g > mainHalf + hr + 44) break;
    }
    // A road that never comes near the through road is not merging with it in any visible way.
    if (adjacentUntil < 20 && gap[0] > mainHalf + hr) return undefined;
    return { reach: (gap.length - 1) * JOIN_STEP_FT, gap, mainHalf, awaySign: away, sideOfMain: side, mainEdge, adjacentUntil };
  };

  const rank = (e: Edge3D, ang: number) => e.priority * 1000 + e.lanes * 10 - ang;
  const taperFor = (e: Edge3D) => Math.min(MERGE_TAPER_FT, e.length * 0.55);

  for (const [nodeId, ins] of inByNode) {
    const outs = outByNode.get(nodeId) ?? [];
    // Merges: several roads arriving along one road's line of travel.
    for (const out of outs) {
      out.spline.getTangentAt(0, tOut);
      const group: { e: Edge3D; ang: number }[] = [];
      for (const i of ins) {
        if (i.fromNodeId === out.toNodeId) continue; // the road coming back the other way
        i.spline.getTangentAt(1, tIn);
        const ang = angleBetween(tIn, tOut);
        if (ang <= MERGE_MAX_ANGLE_RAD) group.push({ e: i, ang });
      }
      if (group.length < 2) continue;
      // Only a freeway has ramps that merge into it. Where ordinary streets meet at a shallow angle it is a junction, and
      // the smaller road keeps its full width instead of narrowing to a point against the bigger one.
      if (!out.isFreeway) continue;
      const main = group.reduce((a, b) => (rank(b.e, b.ang) > rank(a.e, a.ang) ? b : a));
      // The through road carries straight on past a merging ramp: its barriers and lines are not cut at this node.
      main.e.endsAtJunction = false;
      out.startsAtJunction = false;
      for (const g of group) {
        if (g.e === main.e) continue;
        g.e.taperEndFt = Math.max(g.e.taperEndFt, taperFor(g.e));
        g.e.endScale = limitNarrowing(RAMP_TIP, g.e.taperEndFt, g.e);
        g.e.padEnd = buildPad(g.e, main.e, true);
      }
    }
    // Diverges: one road arriving and several leaving along its line of travel.
    for (const i of ins) {
      i.spline.getTangentAt(1, tIn);
      const group: { e: Edge3D; ang: number }[] = [];
      for (const o of outs) {
        if (o.toNodeId === i.fromNodeId) continue;
        o.spline.getTangentAt(0, tOut);
        const ang = angleBetween(tIn, tOut);
        if (ang <= MERGE_MAX_ANGLE_RAD) group.push({ e: o, ang });
      }
      if (group.length < 2) continue;
      if (!i.isFreeway) continue;
      const main = group.reduce((a, b) => (rank(b.e, b.ang) > rank(a.e, a.ang) ? b : a));
      i.endsAtJunction = false;
      main.e.startsAtJunction = false;
      for (const g of group) {
        if (g.e === main.e) continue;
        g.e.taperStartFt = Math.max(g.e.taperStartFt, taperFor(g.e));
        g.e.startScale = limitNarrowing(RAMP_TIP, g.e.taperStartFt, g.e);
        g.e.padStart = buildPad(g.e, main.e, false);
      }
    }
  }

  // Width steps: a road that carries on into a narrower or wider one (a lane added or dropped at the joint) eases its
  // pavement between the two widths, instead of stepping with a squared-off end.
  for (const [nodeId, ins] of inByNode) {
    const outs = outByNode.get(nodeId) ?? [];
    // A lane added or dropped is a change along one road. At a junction with side streets the roads just meet, each at
    // its own width, rather than the approach pinching in before the crossing.
    const legs = new Set<string>();
    for (const e of ins) legs.add(e.fromNodeId);
    for (const o of outs) legs.add(o.toNodeId);
    const crossing = legs.size > 2;
    for (const e of ins) {
      if (e.taperEndFt > 0 || e.isRoundaboutRing) continue;
      e.spline.getTangentAt(1, tIn);
      const cont = outs.filter((o) => {
        if (o.toNodeId === e.fromNodeId) return false;
        o.spline.getTangentAt(0, tOut);
        // A road that begins as a tapering ramp tip is the exit, not the road carrying on.
        if (o.taperStartFt > 0 && o.startScale < 0.5) return false;
        return angleBetween(tIn, tOut) <= MERGE_MAX_ANGLE_RAD * 0.7;
      });
      if (cont.length !== 1) continue;
      const o = cont[0];
      // Full pavement width, shoulders included, since the whole pavement scales with the taper.
      const we = e.lanes * e.laneWidthFt + 8;
      const wo = o.lanes * o.laneWidthFt + 8;
      if (Math.abs(we - wo) <= 1) continue;
      if (crossing) {
        // At a junction with side streets nothing pinches in: the narrower road flares out to meet the wider one, over a
        // short stretch beside the crossing, and the pavements join flush.
        const narrower = we > wo ? o : e;
        // (the carriageways also slide sideways to meet: see below)
        if (narrower.length >= MIN_FLARE_ROAD_FT) {
          const flare = Math.min(WIDTH_FLARE_FT, narrower.length * 0.4);
          // A flare on a bend would push the inside edge of the pavement across itself, so only a straight stretch flares.
          const atStart = narrower === o;
          const ta = narrower.spline.getTangentAt(atStart ? 0 : 1 - flare / narrower.length);
          const tb = narrower.spline.getTangentAt(atStart ? flare / narrower.length : 1);
          if (angleBetween(ta, tb) > (6 * Math.PI) / 180) continue;
          if (we > wo) {
            if (o.taperStartFt === 0) {
              o.taperStartFt = flare;
              o.startScale = limitFlare(Math.min(MAX_FLARE, we / wo), flare, o);
              o.shiftBlendStart = { to: e.lateralShiftFt, len: flare };
            }
          } else if (e.taperEndFt === 0) {
            e.taperEndFt = flare;
            e.endScale = limitFlare(Math.min(MAX_FLARE, wo / we), flare, e);
            e.shiftBlendEnd = { to: o.lateralShiftFt, len: flare };
          }
        }
      } else if (we > wo) {
        e.taperEndFt = Math.min(WIDTH_BLEND_FT, e.length * 0.45);
        e.endScale = limitNarrowing(Math.max(0.3, wo / we), e.taperEndFt, e);
        e.shiftBlendEnd = { to: o.lateralShiftFt, len: e.taperEndFt };
      } else if (o.taperStartFt === 0) {
        o.taperStartFt = Math.min(WIDTH_BLEND_FT, o.length * 0.45);
        o.startScale = limitNarrowing(Math.max(0.3, we / wo), o.taperStartFt, o);
        o.shiftBlendStart = { to: e.lateralShiftFt, len: o.taperStartFt };
      }
    }
  }
}

/** Shared heading at the two ends of a road, so a road that continues into another leaves exactly as it arrived. */
interface JointTangents {
  start?: THREE.Vector3;
  end?: THREE.Vector3;
}

/** Roads that join at more than this plan angle are real turns, not one road continuing, and keep their own shape. */
const JOINT_MAX_ANGLE_RAD = (35 * Math.PI) / 180;
/** How far from a joint the helper control point sits, so the curve leaves along the shared heading. */
const JOINT_HELPER_FT = 25;

/**
 * For every road with authored shape, works out the heading it should share with the road it continues into (and the
 * road that continues into it). Without this each road ends along its own last segment, so two roads meeting at a
 * node arrive and leave at slightly different angles and slopes: on a ramp or a bridge that reads as a kink or a dip.
 */
function computeJointTangents(specs: EdgeSpec[], nodesById: Map<string, NodeSpec>): Map<string, JointTangents> {
  interface Dirs {
    start: THREE.Vector3;
    end: THREE.Vector3;
  }
  const dirs = new Map<string, Dirs>();
  for (const e of specs) {
    const a = nodesById.get(e.fromNodeId);
    const b = nodesById.get(e.toNodeId);
    if (!a || !b) continue;
    const first = e.interiorPoints[0] ?? b.position;
    const last = e.interiorPoints[e.interiorPoints.length - 1] ?? a.position;
    const start = new THREE.Vector3(first[0] - a.position[0], first[1] - a.position[1], first[2] - a.position[2]);
    const end = new THREE.Vector3(b.position[0] - last[0], b.position[1] - last[1], b.position[2] - last[2]);
    if (start.lengthSq() < 1e-6 || end.lengthSq() < 1e-6) continue;
    dirs.set(e.id, { start: start.normalize(), end: end.normalize() });
  }

  const planAngle = (u: THREE.Vector3, v: THREE.Vector3) => {
    const ux = u.x, uz = u.z, vx = v.x, vz = v.z;
    const lu = Math.hypot(ux, uz) || 1;
    const lv = Math.hypot(vx, vz) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (lu * lv))));
  };

  const inByNode = new Map<string, EdgeSpec[]>();
  const outByNode = new Map<string, EdgeSpec[]>();
  for (const e of specs) {
    (inByNode.get(e.toNodeId) ?? inByNode.set(e.toNodeId, []).get(e.toNodeId)!).push(e);
    (outByNode.get(e.fromNodeId) ?? outByNode.set(e.fromNodeId, []).get(e.fromNodeId)!).push(e);
  }

  const result = new Map<string, JointTangents>();
  const set = (id: string, which: "start" | "end", v: THREE.Vector3) => {
    const cur = result.get(id) ?? {};
    cur[which] = v;
    result.set(id, cur);
  };
  for (const [nodeId, ins] of inByNode) {
    const outs = outByNode.get(nodeId) ?? [];
    const bestInFor = new Map<string, { e: EdgeSpec; ang: number }>();
    for (const e of ins) {
      const de = dirs.get(e.id);
      if (!de) continue;
      let best: { n: EdgeSpec; ang: number } | null = null;
      for (const n of outs) {
        if (n.toNodeId === e.fromNodeId) continue; // the road coming back the other way is not a continuation
        const dn = dirs.get(n.id);
        if (!dn) continue;
        const ang = planAngle(de.end, dn.start);
        if (!best || ang < best.ang) best = { n, ang };
        const prev = bestInFor.get(n.id);
        if (!prev || ang < prev.ang) bestInFor.set(n.id, { e, ang });
      }
      if (best && best.ang <= JOINT_MAX_ANGLE_RAD) {
        const dn = dirs.get(best.n.id)!;
        set(e.id, "end", de.end.clone().add(dn.start).normalize());
      }
    }
    for (const [outId, { e, ang }] of bestInFor) {
      if (ang > JOINT_MAX_ANGLE_RAD) continue;
      const spec = specs.find((s) => s.id === outId);
      if (!spec) continue;
      set(outId, "start", dirs.get(e.id)!.end.clone().add(dirs.get(outId)!.start).normalize());
    }
  }
  return result;
}

/** The slope a joint's helper point may carry into a road's end: matching the neighbour's grade, but never a steeper local one than this. */
const HELPER_MAX_GRADE = 0.06;
const clampAbs = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
/** How much of the neighbouring road's slope the joint helper carries (the rest follows this road's own profile). */
const HELPER_SLOPE_SHARE = 0.5;
const SHORT_DECK_FT = 0;
const SHORT_DECK_SHARE = 0.5;

/**
 * Height of a joint's helper point `h` feet in from `end`. On the road's own profile (the straight line from the end to
 * the next control point) it adds no steepness; shifted toward the neighbour's slope it keeps the two roads' slopes
 * close at the joint. Mostly the first, a little of the second.
 */
function blendedHelperY(end: THREE.Vector3, next: THREE.Vector3, slopeY: number, h: number, share: number): number {
  const own = end.y + (next.y - end.y) * Math.min(1, h / Math.max(1e-3, end.distanceTo(next)));
  const shared = end.y + clampAbs(slopeY - end.y, HELPER_MAX_GRADE * h);
  return own + (shared - own) * share;
}

function buildSpline(
  spec: EdgeSpec,
  nodesById: Map<string, NodeSpec>,
  neighborsByNode: Map<string, Set<string>>,
  joint?: JointTangents
): THREE.CatmullRomCurve3 {
  const fromNode = nodesById.get(spec.fromNodeId);
  const toNode = nodesById.get(spec.toNodeId);
  if (!fromNode || !toNode) {
    throw new Error(`Edge ${spec.id} references unknown node`);
  }
  const from = fromNode.position;
  const to = toNode.position;

  // A plain node-to-node ramp with a real elevation change gets a smooth
  // (ease-in/out) vertical curve instead of one straight linear grade line,
  // so the deck doesn't kink where it meets a flat approach at either end —
  // the "sharp kink" a real vertical curve (PVC/PVT) is designed to remove.
  // Edges with player-placed interior points keep their authored shape.
  if (spec.interiorPoints.length === 0 && Math.abs(to[1] - from[1]) > VERTICAL_CURVE_THRESHOLD_FT) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= VERTICAL_CURVE_STEPS; i++) {
      const t = i / VERTICAL_CURVE_STEPS;
      const eased = t * t * (3 - 2 * t); // smoothstep: zero slope at both ends
      points.push(
        new THREE.Vector3(
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * eased,
          from[2] + (to[2] - from[2]) * t
        )
      );
    }
    return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
  }

  // A flat (or near-flat) edge with no authored shape gets its endpoint
  // tangents blended with whatever road continues past each end — a plain
  // "bend point" the player tapped into a road while drawing keeps
  // travelling smoothly through it instead of the pavement kinking to a
  // sharp vertex where two dead-straight edges meet. A dead end or a real
  // multi-way junction has no single unambiguous "continuing" direction, so
  // that end is left as a straight approach exactly as before — only a
  // node with precisely one neighbor on the far side counts as a bend.
  if (spec.interiorPoints.length === 0) {
    const fromV = new THREE.Vector3(...from);
    const toV = new THREE.Vector3(...to);
    const prevNeighborId = singleOtherNeighbor(neighborsByNode, spec.fromNodeId, spec.toNodeId);
    const nextNeighborId = singleOtherNeighbor(neighborsByNode, spec.toNodeId, spec.fromNodeId);
    const prevNode = prevNeighborId ? nodesById.get(prevNeighborId) : undefined;
    const nextNode = nextNeighborId ? nodesById.get(nextNeighborId) : undefined;

    if (prevNode || nextNode || joint) {
      const chordLength = toV.distanceTo(fromV);
      const straightDir = toV.clone().sub(fromV).normalize();
      // Tangent direction follows the neighboring segment (Catmull-Rom
      // style: "prev -> to" / "from -> next"), but its magnitude is scaled
      // to this edge's own length rather than the neighbor's — otherwise a
      // long lead-in segment feeding a short one would wildly overshoot the
      // control points and bulge or loop the curve.
      // Horizontal only: this edge is flat, and if the neighbouring road climbs (a ramp onto a viaduct), letting its
      // rise tilt our tangent drags the control points below ground and buries the end of the road, leaving only
      // the barrier tops poking out of the grass.
      const flatten = (v: THREE.Vector3) => {
        v.y = 0;
        return v.lengthSq() > 1e-6 ? v.normalize() : straightDir.clone();
      };
      // A neighbour that turns away sharply is a corner, not a continuation: following it would hook the curve (a short
      // edge between two roads at right angles bent into an S), so that end stays straight.
      const MAX_BLEND_TURN = Math.cos((55 * Math.PI) / 180);
      const blended = (dir: THREE.Vector3) => (dir.dot(straightDir) >= MAX_BLEND_TURN ? dir : straightDir);
      // Where the neighbouring road has a shape of its own, the heading it really arrives with (shared with this road in
      // `joint`) beats the straight line to its far node, so the two leave and arrive on exactly the same line.
      const shared = (dir: THREE.Vector3 | undefined) => (dir ? blended(flatten(dir.clone())) : undefined);
      const startDir = shared(joint?.start) ?? (prevNode ? blended(flatten(toV.clone().sub(new THREE.Vector3(...prevNode.position)))) : straightDir);
      const endDir = shared(joint?.end) ?? (nextNode ? blended(flatten(new THREE.Vector3(...nextNode.position).sub(fromV))) : straightDir);

      const control1 = fromV.clone().addScaledVector(startDir, chordLength / 3);
      const control2 = toV.clone().addScaledVector(endDir, -chordLength / 3);
      const bezier = new THREE.CubicBezierCurve3(fromV, control1, control2, toV);

      // Resample as a CatmullRomCurve3 (rather than returning the Bezier
      // directly) so every downstream consumer of Edge3D.spline keeps
      // working against the exact same curve type unchanged.
      // Samples are packed close together at both ends, so the resampled curve leaves and arrives along the Bezier's own
      // end tangents (with evenly spaced samples the end direction is the last chord's, which is off by a few degrees on
      // a long edge and shows as a kink where two roads meet).
      const sampled: THREE.Vector3[] = [];
      const ts = [0, 0.008, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.992, 1];
      for (const t of ts) sampled.push(bezier.getPoint(t));
      return new THREE.CatmullRomCurve3(sampled, false, "centripetal", 0.5);
    }
  }

  const points: THREE.Vector3[] = [new THREE.Vector3(...from)];
  for (const p of spec.interiorPoints) points.push(new THREE.Vector3(...p));
  points.push(new THREE.Vector3(...to));
  // Make the ends leave along the heading shared with the neighbouring road: a helper point a short way in, on that
  // heading, pins the curve's end tangent to it.
  let helped = false;
  if (joint && points.length >= 3) {
    // A shared heading only helps if it roughly agrees with how this road really arrives there; one that points well
    // away from the road's own last stretch would put the helper off to the side and hook the curve into a spike.
    const agrees = (dir: THREE.Vector3, along: THREE.Vector3) => {
      const flat = new THREE.Vector3(along.x, 0, along.z);
      const d = new THREE.Vector3(dir.x, 0, dir.z);
      if (flat.lengthSq() < 1e-6 || d.lengthSq() < 1e-6) return false;
      return flat.normalize().dot(d.normalize()) > Math.cos((50 * Math.PI) / 180);
    };
    // A short deck has no room to pick up its neighbour's slope without steepening in the middle (an S in profile), so it
    // follows its own line; only longer roads carry some of the shared slope.
    let polyline = 0;
    for (let i = 1; i < points.length; i++) polyline += points[i].distanceTo(points[i - 1]);
    const slopeShare = polyline < SHORT_DECK_FT ? SHORT_DECK_SHARE : HELPER_SLOPE_SHARE;
    const endOk = !!joint.end && agrees(joint.end, points[points.length - 1].clone().sub(points[points.length - 2]));
    const startOk = !!joint.start && agrees(joint.start, points[1].clone().sub(points[0]));
    helped = endOk || startOk;
    if (endOk && joint.end) {
      const last = points[points.length - 1];
      const h = Math.min(JOINT_HELPER_FT, last.distanceTo(points[points.length - 2]) * 0.4);
      const helper = last.clone().addScaledVector(joint.end, -h);
      // It carries the shared slope too, but not below ground: at the foot of a ramp that would dip the road under the grass.
      const before = points[points.length - 2];
      helper.y = blendedHelperY(last, before, helper.y, h, slopeShare);
      if (last.y >= 0 && before.y >= 0) helper.y = Math.max(0, helper.y);
      points.splice(points.length - 1, 0, helper);
    }
    if (startOk && joint.start) {
      const first = points[0];
      const h = Math.min(JOINT_HELPER_FT, first.distanceTo(points[1]) * 0.4);
      const helper = first.clone().addScaledVector(joint.start, h);
      helper.y = blendedHelperY(first, points[1], helper.y, h, slopeShare);
      if (first.y >= 0 && points[1].y >= 0) helper.y = Math.max(0, helper.y);
      points.splice(1, 0, helper);
    }
  }
  // The helper sits a few feet from the end while the next control point can be hundreds of feet away. A uniform
  // Catmull-Rom curve overshoots across such uneven spacing and doubles back on itself at the end (a hairpin spur that
  // folds the pavement); the centripetal form does not.
  // Uneven spacing (a long stretch then a short one) makes the uniform form overshoot and loop at the short end.
  let shortest = Infinity;
  let longest = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i].distanceTo(points[i - 1]);
    shortest = Math.min(shortest, d);
    longest = Math.max(longest, d);
  }
  const uneven = points.length >= 3 && longest > shortest * 3;
  return new THREE.CatmullRomCurve3(points, false, helped || uneven ? "centripetal" : "catmullrom", 0.5);
}

/**
 * True when every control point is within a tenth of a foot of the same height: a road on level ground, whose profile
 * can neither dip nor climb, so the tests that sample it for grade and for dips can be skipped (most of a real city,
 * and the biggest saving when one loads).
 */
function isFlat(curve: THREE.CatmullRomCurve3): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of curve.points) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return hi - lo <= 0.1;
}

/**
 * A curve through control points that are all at or above ground can still dip a foot below it between them (the
 * overshoot at the base of a ramp). That buries the pavement and the vehicles on it, so such a curve is traced again at
 * short intervals with the dip taken out. A road meant to go underground (a control point below ground) is left alone.
 */
function keepAboveGround(curve: THREE.CatmullRomCurve3): THREE.CatmullRomCurve3 {
  if (curve.points.some((p) => p.y < -0.05)) return curve;
  if (isFlat(curve)) return curve;
  const probe = new THREE.Vector3();
  let low = 0;
  for (let i = 0; i <= 40; i++) low = Math.min(low, curve.getPointAt(i / 40, probe).y);
  if (low > -0.15) return curve;
  return traceProfile(curve, (y) => Math.max(0, y));
}

/** Traces a curve again at short intervals, passing each height through `shape`. */
function traceProfile(curve: THREE.CatmullRomCurve3, shape: (y: number, s: number, length: number) => number): THREE.CatmullRomCurve3 {
  const length = curve.getLength();
  const steps = Math.max(8, Math.ceil(length / 8));
  const traced: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = curve.getPointAt(i / steps);
    p.y = shape(p.y, (length * i) / steps, length);
    traced.push(p);
  }
  return new THREE.CatmullRomCurve3(traced, false, "centripetal", 0.5);
}

/** The steepest a road's deck may be anywhere along it (the game's design limit is 6%; the curve through the control points overshoots it a little). */
const MAX_LOCAL_GRADE = 0.075;

/**
 * A short bridge can come out steeper than the limit somewhere in the middle (the curve through its control points
 * overshoots). Its profile is pulled back to the nearest one that nowhere exceeds the limit, ends held exactly, so the
 * climb is spread over a little more of the deck instead of being steepest in one place.
 */
function limitGrade(curve: THREE.CatmullRomCurve3): THREE.CatmullRomCurve3 {
  if (isFlat(curve)) return curve;
  const length = curve.getLength();
  if (length < 30) return curve;
  const n = Math.max(8, Math.ceil(length / 6));
  const ds = length / n;
  const ys: number[] = [];
  for (let i = 0; i <= n; i++) ys.push(curve.getPointAt(i / n).y);
  let steepest = 0;
  for (let i = 1; i <= n; i++) steepest = Math.max(steepest, Math.abs(ys[i] - ys[i - 1]) / ds);
  if (steepest <= MAX_LOCAL_GRADE + 0.004) return curve;
  // If the ends themselves are further apart than the limit allows over this length, there is nothing the middle can do.
  if (Math.abs(ys[n] - ys[0]) > MAX_LOCAL_GRADE * length * 0.95) return curve;
  const step = MAX_LOCAL_GRADE * ds;
  const y0 = ys[0];
  const yn = ys[n];
  for (let pass = 0; pass < 60; pass++) {
    for (let i = 1; i <= n; i++) ys[i] = Math.max(ys[i - 1] - step, Math.min(ys[i - 1] + step, ys[i]));
    ys[n] = yn;
    for (let i = n - 1; i >= 0; i--) ys[i] = Math.max(ys[i + 1] - step, Math.min(ys[i + 1] + step, ys[i]));
    ys[0] = y0;
  }
  return traceProfile(curve, (_y, s) => {
    const f = Math.min(n - 1e-9, Math.max(0, s / ds));
    const i = Math.floor(f);
    return ys[i] + (ys[i + 1] - ys[i]) * (f - i);
  });
}

/** How far below ground a road must dip to count as an underpass or cutting rather than a rounding overshoot at the base of a ramp. */
const SUNKEN_DEPTH_FT = 1.5;

function isSunken(curve: THREE.CatmullRomCurve3): boolean {
  const p = new THREE.Vector3();
  for (let i = 0; i <= ELEVATION_SAMPLE_STEPS; i++) {
    curve.getPointAt(i / ELEVATION_SAMPLE_STEPS, p);
    if (p.y < -SUNKEN_DEPTH_FT) return true;
  }
  return false;
}

function computeIsElevated(curve: THREE.CatmullRomCurve3): boolean {
  const p = new THREE.Vector3();
  for (let i = 0; i <= ELEVATION_SAMPLE_STEPS; i++) {
    curve.getPointAt(i / ELEVATION_SAMPLE_STEPS, p);
    if (p.y > ELEVATION_THRESHOLD_FT) return true;
  }
  return false;
}

/**
 * Pure function converting the editable NetworkSnapshot into the runtime
 * RoadNetwork (real splines, derived adjacency). Called independently by
 * both the main thread (for rendering) and the simulation worker (for
 * routing/physics) — the two never need to share live THREE objects across
 * the postMessage boundary, only the plain snapshot data.
 */
export function assembleNetwork(snapshot: NetworkSnapshot): RoadNetwork {
  const nodesById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const neighborsByNode = buildNeighborsByNode(snapshot.edges);

  const jointTangents = computeJointTangents(snapshot.edges, nodesById);
  const edges: Edge3D[] = snapshot.edges.map((spec) => {
    const spline = keepAboveGround(limitGrade(buildSpline(spec, nodesById, neighborsByNode, jointTangents.get(spec.id))));
    const length = spline.getLength();
    const roadClass = ROAD_CLASSES[spec.roadClassId];
    return {
      id: spec.id,
      fromNodeId: spec.fromNodeId,
      toNodeId: spec.toNodeId,
      spline,
      lanes: spec.lanes,
      laneWidthFt: spec.laneWidthFt,
      speedLimitMph: spec.speedLimitMph,
      length,
      roadClassId: spec.roadClassId,
      elevationLevelId: spec.elevationLevelId,
      priority: spec.isRoundaboutRing
        ? ROUNDABOUT_PRIORITY
        : spec.isTexasTurnaround
          ? TEXAS_TURNAROUND_PRIORITY
          : roadClass.priority,
      isFreeway: spec.roadClassId === "highway" || spec.roadClassId === "motorway",
      isElevated: computeIsElevated(spline),
      zone: spec.zone,
      isRoundaboutRing: spec.isRoundaboutRing ?? false,
      isTexasTurnaround: spec.isTexasTurnaround ?? false,
      lateralShiftFt: 0,
      shiftTaperStart: false,
      shiftTaperEnd: false,
      shiftBlendStart: null,
      shiftBlendEnd: null,
      startsAtJunction: (neighborsByNode.get(spec.fromNodeId)?.size ?? 0) >= 3,
      endsAtJunction: (neighborsByNode.get(spec.toNodeId)?.size ?? 0) >= 3,
      taperStartFt: 0,
      taperEndFt: 0,
      startScale: 1,
      endScale: 1,
      sunken: isSunken(spline),
      reservedLane: spec.lanes >= 2 ? (spec.reservedLane ?? null) : null,
      bannedTurns: spec.bannedTurns ?? [],
      allNextEdgeIds: [],
      meterS: spec.meterS ?? 0,
      meterAuto: spec.meterAuto ?? false,
      crosswalk: spec.crosswalk ?? false,
      jaywalkers: spec.jaywalkers ?? false,
      busStop: spec.busStop ?? false,
      parking: spec.parking ?? false,
      vslMph: spec.vslMph ?? null,
      closedLanes: Array.from({ length: spec.lanes }, (_, i) => (spec.closedLanes ?? []).includes(i)),
      displacedLeft: spec.displacedLeft ?? false,
      name: spec.name,
      ref: spec.ref,
      ramp: spec.ramp,
      nextEdgeIds: [],
      manualLaneMoves: spec.laneMoves ?? null,
      nextMoves: new Map(),
      laneAllowed: null,
      laneMoves: Array.from({ length: spec.lanes }, () => ["straight" as LaneMove]),
      autoLaneMoves: Array.from({ length: spec.lanes }, () => ["straight" as LaneMove]),
    };
  });

  const edgesById = new Map(edges.map((e) => [e.id, e]));

  // The two directions of a two-way road sit side by side: each carriageway is shifted to its own right of the
  // shared centerline (and half a median further on divided classes), so opposing traffic never shares pavement.
  const directed = new Set(edges.map((e) => `${e.fromNodeId}>${e.toNodeId}`));
  for (const edge of edges) {
    if (edge.isRoundaboutRing || edge.isTexasTurnaround) continue;
    if (!directed.has(`${edge.toNodeId}>${edge.fromNodeId}`)) continue;
    const cls = ROAD_CLASSES[edge.roadClassId];
    edge.lateralShiftFt = (edge.lanes * edge.laneWidthFt) / 2 + (cls.divided ? cls.medianGapFt / 2 : 0);
    // Where the road merely continues through a node (two neighbours) both sides keep the full shift;
    // junctions and dead ends pull cars in toward the centre instead.
    edge.shiftTaperStart = (neighborsByNode.get(edge.fromNodeId)?.size ?? 0) !== 2;
    edge.shiftTaperEnd = (neighborsByNode.get(edge.toNodeId)?.size ?? 0) !== 2;
  }

  classifyMergesAndDiverges(edges);

  // Roads leaving each node, in the order the edges were given (so route ties break as they always did).
  const leaving = new Map<string, string[]>();
  for (const e of edges) {
    const list = leaving.get(e.fromNodeId);
    if (list) list.push(e.id);
    else leaving.set(e.fromNodeId, [e.id]);
  }
  for (const edge of edges) {
    edge.allNextEdgeIds = (leaving.get(edge.toNodeId) ?? []).slice();
    applyTurnBans(edge, edgesById);
  }

  for (const edge of edges) {
    computeLaneUse(edge, edgesById);
  }

  return { nodesById, edges, edgesById };
}

// ---------------------------------------------------------------------------
// A one-slot memoization cache for assembleNetwork, keyed by the exact
// `nodes`/`edges` array references. RoadNetworkMesh, InfoPanel's live edge
// and junction inspectors, and JointClackDetector each independently call
// assembleNetwork off the same editor-store arrays, which — for anything
// past a small network — is real, duplicated O(edges^2) work (the diverge-
// lane assignment pass) done up to four times per store update instead of
// once. Since the store's `nodes`/`edges` are only ever replaced wholesale
// (never mutated in place), a same-reference check is a safe, exact cache
// hit test — no risk of serving stale data.
// ---------------------------------------------------------------------------
let cachedNodes: NodeSpec[] | null = null;
let cachedEdges: EdgeSpec[] | null = null;
let cachedNetwork: RoadNetwork | null = null;

/** Same result as `assembleNetwork({ nodes, edges })`, but reuses the last computed network when both array references are unchanged since the last call — see the module-level comment above. */
export function assembleNetworkCached(nodes: NodeSpec[], edges: EdgeSpec[]): RoadNetwork {
  if (cachedNetwork && cachedNodes === nodes && cachedEdges === edges) {
    return cachedNetwork;
  }
  cachedNodes = nodes;
  cachedEdges = edges;
  cachedNetwork = assembleNetwork({ nodes, edges });
  return cachedNetwork;
}

const UP = new THREE.Vector3(0, 1, 0);
const STRAIGHT_HALF_ANGLE = (30 * Math.PI) / 180;

/** Buckets an exit by the signed heading change from this edge's end to the next edge's start (positive = right). */
function classifyMove(edge: Edge3D, next: Edge3D): { move: LaneMove; score: number } {
  const tangentEnd = edge.spline.getTangentAt(1);
  const rightEnd = new THREE.Vector3().crossVectors(tangentEnd, UP).normalize();
  const tangentNext = next.spline.getTangentAt(0);
  const score = tangentNext.dot(rightEnd);
  const angle = Math.atan2(score, tangentNext.dot(tangentEnd));
  if (Math.abs(angle) < STRAIGHT_HALF_ANGLE) return { move: "straight", score };
  // Near-reversals (U-turns) read as left, as they do in real lane signage.
  if (angle > 0 && angle < Math.PI * 0.83) return { move: "right", score };
  return { move: "left", score };
}

/**
 * Drops the turns the player banned at the end of this road from where it can lead, so drivers route around them
 * (and no lane is painted with the banned arrow). A ban that would leave nowhere to go is ignored.
 */
export function applyTurnBans(edge: Edge3D, edgesById: Map<string, Edge3D>): void {
  if (edge.bannedTurns.length === 0) {
    edge.nextEdgeIds = edge.allNextEdgeIds.slice();
    return;
  }
  const kept = edge.allNextEdgeIds.filter((id) => {
    const next = edgesById.get(id);
    return !!next && !edge.bannedTurns.includes(classifyMove(edge, next).move);
  });
  edge.nextEdgeIds = kept.length > 0 ? kept : edge.allNextEdgeIds.slice();
}

function isValidManualMoves(edge: Edge3D, moves: LaneMove[][] | null): moves is LaneMove[][] {
  return !!moves && moves.length === edge.lanes && moves.every((m) => m.length > 0);
}

/**
 * Works out which lanes may take which exit. Automatic mode splits lanes into
 * contiguous left-to-right ranges ordered by exit heading; manual mode (player
 * lane arrows) allows exactly the moves painted on each lane, falling back to
 * "any lane" for an exit no lane can reach so the player can't strand traffic.
 * Safe to call again after a live patch.
 */
export function computeLaneUse(edge: Edge3D, edgesById: Map<string, Edge3D>): void {
  const straightAll = () => Array.from({ length: edge.lanes }, () => ["straight" as LaneMove]);
  edge.nextMoves = new Map();
  edge.laneAllowed = null;
  edge.laneMoves = straightAll();
  edge.autoLaneMoves = straightAll();

  // A U-turn onto the road's own opposite direction is never painted on a lane (real roads don't), and counting it
  // would fork the lanes of every plain mid-block node into a fake "turn left" arrow.
  const nextEdges = edge.nextEdgeIds
    .map((id) => edgesById.get(id))
    .filter((e): e is Edge3D => !!e)
    .filter((e) => !(e.fromNodeId === edge.toNodeId && e.toNodeId === edge.fromNodeId));
  if (nextEdges.length === 0) return;

  const scored = nextEdges.map((ne) => {
    const c = classifyMove(edge, ne);
    edge.nextMoves.set(ne.id, c.move);
    return { id: ne.id, move: c.move, score: c.score };
  });
  if (nextEdges.length < 2) return;

  // Automatic: contiguous ranges ordered left-to-right by exit heading.
  scored.sort((a, b) => a.score - b.score);
  const lanes = edge.lanes;
  const count = scored.length;
  const base = Math.floor(lanes / count);
  let remainder = lanes - base * count;
  const autoAllowed = new Map<string, boolean[]>();
  const autoMoves: Set<LaneMove>[] = Array.from({ length: lanes }, () => new Set<LaneMove>());
  let cursor = 0;
  for (const s of scored) {
    let laneCount = base;
    if (remainder > 0) {
      laneCount += 1;
      remainder -= 1;
    }
    if (laneCount < 1) laneCount = 1;
    const start = Math.min(cursor, lanes - 1);
    const end = Math.min(lanes - 1, cursor + laneCount - 1);
    const allowed = new Array<boolean>(lanes).fill(false);
    for (let i = start; i <= end; i++) {
      allowed[i] = true;
      autoMoves[i].add(s.move);
    }
    autoAllowed.set(s.id, allowed);
    cursor = end + 1;
  }
  edge.autoLaneMoves = autoMoves.map((set) => (set.size > 0 ? orderMoves(set) : ["straight"]));

  if (isValidManualMoves(edge, edge.manualLaneMoves)) {
    const manual = edge.manualLaneMoves;
    const allowedByNext = new Map<string, boolean[]>();
    for (const s of scored) {
      const arr = manual.map((moves) => moves.includes(s.move));
      allowedByNext.set(s.id, arr.some(Boolean) ? arr : new Array<boolean>(lanes).fill(true));
    }
    edge.laneAllowed = allowedByNext;
    edge.laneMoves = manual.map((m) => orderMoves(new Set(m)));
  } else {
    edge.laneAllowed = autoAllowed;
    edge.laneMoves = edge.autoLaneMoves;
  }
}

function orderMoves(set: Set<LaneMove>): LaneMove[] {
  return (["left", "straight", "right"] as LaneMove[]).filter((m) => set.has(m));
}

/** The limit drivers actually obey: the gantry's advisory if one is set (never above the posted limit), else the posted limit. */
export function effectiveSpeedLimitMph(edge: Edge3D): number {
  return edge.vslMph !== null ? Math.min(edge.vslMph, edge.speedLimitMph) : edge.speedLimitMph;
}

/** Whether a road gets an overhead gantry: a freeway with room for one. Where it stands: halfway along. */
export function hasGantry(edge: Edge3D): boolean {
  return edge.isFreeway && edge.lanes >= 2 && edge.length >= 700 && !edge.isRoundaboutRing && !edge.isTexasTurnaround;
}

/** Applies a live edit (speed limit and/or lane arrows) to an assembled edge in place. */
export function patchEdge(
  edge: Edge3D,
  edgesById: Map<string, Edge3D>,
  patch: EdgePatch
): void {
  edge.speedLimitMph = patch.speedLimitMph;
  edge.manualLaneMoves = patch.laneMoves;
  if (patch.reservedLane !== undefined) edge.reservedLane = edge.lanes >= 2 ? patch.reservedLane : null;
  if (patch.meterS !== undefined) edge.meterS = patch.meterS;
  if (patch.meterAuto !== undefined) edge.meterAuto = patch.meterAuto;
  if (patch.bannedTurns !== undefined) {
    edge.bannedTurns = patch.bannedTurns;
    applyTurnBans(edge, edgesById);
  }
  if (patch.crosswalk !== undefined) edge.crosswalk = patch.crosswalk;
  if (patch.busStop !== undefined) edge.busStop = patch.busStop;
  if (patch.parking !== undefined) edge.parking = patch.parking;
  if (patch.vslMph !== undefined) edge.vslMph = patch.vslMph;
  if (patch.closedLanes !== undefined) edge.closedLanes = Array.from({ length: edge.lanes }, (_, i) => patch.closedLanes!.includes(i));
  if (patch.displacedLeft !== undefined) edge.displacedLeft = patch.displacedLeft;
  computeLaneUse(edge, edgesById);
}

/**
 * Shortest-route search (Dijkstra, weighted by estimated travel time) over
 * the edge-adjacency graph. Small networks (hundreds of edges), so a plain
 * O(V^2) scan is simpler and plenty fast — no heap needed.
 */
export function computeRoute(
  network: RoadNetwork,
  fromEdgeId: string,
  toEdgeId: string,
  /** Roads nobody may be routed onto (a closure), other than the destination itself. */
  blocked?: Set<string>
): string[] | null {
  if (fromEdgeId === toEdgeId) return [fromEdgeId];

  const startEdge = network.edgesById.get(fromEdgeId);
  if (!startEdge || !network.edgesById.has(toEdgeId)) return null;

  const travelTime = (e: Edge3D) => e.length / Math.max(mphToFtps(e.speedLimitMph), 1);

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  // A binary heap in place of scanning every known edge for the nearest one. Ties go to whichever edge was reached
  // first, exactly as the scan did, so routes are unchanged.
  const heapD: number[] = [];
  const heapO: number[] = [];
  const heapId: string[] = [];
  const order = new Map<string, number>();
  const less = (i: number, j: number) => heapD[i] < heapD[j] || (heapD[i] === heapD[j] && heapO[i] < heapO[j]);
  const swap = (i: number, j: number) => {
    [heapD[i], heapD[j]] = [heapD[j], heapD[i]];
    [heapO[i], heapO[j]] = [heapO[j], heapO[i]];
    [heapId[i], heapId[j]] = [heapId[j], heapId[i]];
  };
  const push = (id: string, d: number) => {
    let o = order.get(id);
    if (o === undefined) {
      o = order.size;
      order.set(id, o);
    }
    heapD.push(d);
    heapO.push(o);
    heapId.push(id);
    let i = heapD.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(i, parent)) break;
      swap(i, parent);
      i = parent;
    }
  };
  const pop = () => {
    const top = heapId[0];
    const last = heapD.length - 1;
    swap(0, last);
    heapD.pop();
    heapO.pop();
    heapId.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heapD.length && less(l, m)) m = l;
      if (r < heapD.length && less(r, m)) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
    return top;
  };
  dist.set(fromEdgeId, travelTime(startEdge));
  push(fromEdgeId, dist.get(fromEdgeId)!);

  for (;;) {
    let currentId: string | null = null;
    let currentDist = Infinity;
    while (heapD.length > 0) {
      const d = heapD[0];
      const id = pop();
      if (visited.has(id) || d !== dist.get(id)) continue; // a stale entry
      currentId = id;
      currentDist = d;
      break;
    }
    if (currentId === null || currentId === toEdgeId) break;
    visited.add(currentId);

    const currentEdge = network.edgesById.get(currentId);
    if (!currentEdge) continue;

    for (const nextId of currentEdge.nextEdgeIds) {
      if (visited.has(nextId)) continue;
      if (blocked && blocked.has(nextId) && nextId !== toEdgeId) continue;
      const nextEdge = network.edgesById.get(nextId);
      if (!nextEdge) continue;
      const candidate = currentDist + travelTime(nextEdge);
      if (candidate < (dist.get(nextId) ?? Infinity)) {
        dist.set(nextId, candidate);
        prev.set(nextId, currentId);
        push(nextId, candidate);
      }
    }
  }

  if (!dist.has(toEdgeId)) return null;

  const path: string[] = [toEdgeId];
  let cursor = toEdgeId;
  while (cursor !== fromEdgeId) {
    const p = prev.get(cursor);
    if (!p) return null;
    path.push(p);
    cursor = p;
  }
  path.reverse();
  return path;
}

export interface EdgePointHit {
  t: number;
  point: THREE.Vector3;
  distSq: number;
}

/**
 * Finds the closest point on an edge's centerline to a given world point via
 * coarse-then-fine sampling. One-off editor interaction (e.g. clicking a
 * road to anchor a Texas turnaround) — never called in the simulation's
 * per-tick hot path, so a few dozen curve samples is a fine cost.
 */
export function findClosestPointOnEdge(edge: Edge3D, point: THREE.Vector3, coarseSteps = 40): EdgePointHit {
  let bestT = 0;
  let bestDistSq = Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i <= coarseSteps; i++) {
    const t = i / coarseSteps;
    edge.spline.getPointAt(t, p);
    const d = p.distanceToSquared(point);
    if (d < bestDistSq) {
      bestDistSq = d;
      bestT = t;
    }
  }

  let lo = Math.max(0, bestT - 1 / coarseSteps);
  let hi = Math.min(1, bestT + 1 / coarseSteps);
  const fineSteps = 10;
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i <= fineSteps; i++) {
      const t = lo + ((hi - lo) * i) / fineSteps;
      edge.spline.getPointAt(t, p);
      const d = p.distanceToSquared(point);
      if (d < bestDistSq) {
        bestDistSq = d;
        bestT = t;
      }
    }
    const newSpan = (hi - lo) / fineSteps;
    lo = Math.max(0, bestT - newSpan);
    hi = Math.min(1, bestT + newSpan);
  }

  const point3 = new THREE.Vector3();
  edge.spline.getPointAt(bestT, point3);
  return { t: bestT, point: point3, distSq: bestDistSq };
}

export interface TexasTurnaroundPlan {
  /** The opposing (roughly anti-parallel) edge the loop merges back into. */
  targetEdgeId: string;
  nodeAPoint: [number, number, number];
  nodeBPoint: [number, number, number];
  controlPoint1: [number, number, number];
  controlPoint2: [number, number, number];
  lengthFt: number;
}

const _turnaroundUp = new THREE.Vector3(0, 1, 0);

/**
 * Pure geometry planner shared by the live hover preview and the actual
 * Texas turnaround build action: given a clicked/hovered edge and an anchor
 * point on it, finds the nearest opposing (anti-parallel) frontage edge
 * within range and computes the looped slip-lane path connecting them.
 * Returns null if no suitable opposing edge exists nearby — never mutates
 * anything.
 */
export function planTexasTurnaround(
  network: RoadNetwork,
  edgeId: string,
  anchorPoint: THREE.Vector3
): TexasTurnaroundPlan | null {
  const edgeA = network.edgesById.get(edgeId);
  if (!edgeA) return null;

  const hitA = findClosestPointOnEdge(edgeA, anchorPoint);
  const dirA = edgeA.spline.getTangentAt(hitA.t);
  const right = new THREE.Vector3().crossVectors(dirA, _turnaroundUp).normalize();

  let best: { edgeId: string; point: THREE.Vector3; dir: THREE.Vector3; distSq: number } | null = null;
  for (const candidate of network.edges) {
    if (candidate.id === edgeA.id) continue;
    if (candidate.isRoundaboutRing || candidate.isTexasTurnaround) continue;
    if (
      candidate.fromNodeId === edgeA.fromNodeId ||
      candidate.fromNodeId === edgeA.toNodeId ||
      candidate.toNodeId === edgeA.fromNodeId ||
      candidate.toNodeId === edgeA.toNodeId
    ) {
      continue; // already meets edge A at a shared node — not a separate frontage road
    }
    const hit = findClosestPointOnEdge(candidate, hitA.point);
    if (hit.distSq > TEXAS_TURNAROUND_SEARCH_RADIUS_FT * TEXAS_TURNAROUND_SEARCH_RADIUS_FT) continue;
    const candidateDir = candidate.spline.getTangentAt(hit.t);
    if (dirA.dot(candidateDir) > -0.7) continue; // must run roughly the opposite direction
    if (!best || hit.distSq < best.distSq) {
      best = { edgeId: candidate.id, point: hit.point, dir: candidateDir, distSq: hit.distSq };
    }
  }

  if (!best) return null;

  const dirB = best.dir;
  const nodeAPos = hitA.point;
  const nodeBPos = best.point;

  const lateralGapFt = Math.hypot(nodeBPos.x - nodeAPos.x, nodeBPos.z - nodeAPos.z);
  const loopRadiusFt = Math.max(TEXAS_TURNAROUND_MIN_RADIUS_FT, lateralGapFt / 2 + 10);
  const lateralSign =
    Math.sign((nodeBPos.x - nodeAPos.x) * right.x + (nodeBPos.z - nodeAPos.z) * right.z) || 1;

  const controlPoint1: [number, number, number] = [
    nodeAPos.x + dirA.x * loopRadiusFt * 0.6 + right.x * lateralSign * loopRadiusFt,
    nodeAPos.y,
    nodeAPos.z + dirA.z * loopRadiusFt * 0.6 + right.z * lateralSign * loopRadiusFt,
  ];
  const controlPoint2: [number, number, number] = [
    nodeBPos.x - dirB.x * loopRadiusFt * 0.6 + right.x * lateralSign * loopRadiusFt,
    nodeBPos.y,
    nodeBPos.z - dirB.z * loopRadiusFt * 0.6 + right.z * lateralSign * loopRadiusFt,
  ];

  const points = [
    new THREE.Vector3(nodeAPos.x, nodeAPos.y, nodeAPos.z),
    new THREE.Vector3(...controlPoint1),
    new THREE.Vector3(...controlPoint2),
    new THREE.Vector3(nodeBPos.x, nodeBPos.y, nodeBPos.z),
  ];
  const lengthFt = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5).getLength();

  return {
    targetEdgeId: best.edgeId,
    nodeAPoint: [nodeAPos.x, nodeAPos.y, nodeAPos.z],
    nodeBPoint: [nodeBPos.x, nodeBPos.y, nodeBPos.z],
    controlPoint1,
    controlPoint2,
    lengthFt,
  };
}

function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/**
 * Buckets a node's incoming edges into two traffic-signal phase groups
 * using approach heading: edges arriving roughly head-on to each other
 * (opposing through movements) or from the same direction share a phase,
 * everything else goes to the other phase. A reasonable default for T- and
 * 4-way junctions without requiring the user to hand-assign phases.
 */
export function computeSignalPhaseGroups(
  nodeId: string,
  edges: EdgeSpec[],
  nodesById: Map<string, NodeSpec>
): { groupA: string[]; groupB: string[] } {
  const incoming = edges.filter((e) => e.toNodeId === nodeId);
  const headings = incoming
    .map((e) => {
      const from = nodesById.get(e.fromNodeId);
      const to = nodesById.get(e.toNodeId);
      if (!from || !to) return null;
      const dx = to.position[0] - from.position[0];
      const dz = to.position[2] - from.position[2];
      return { id: e.id, angle: Math.atan2(dz, dx) };
    })
    .filter((h): h is { id: string; angle: number } => h !== null);

  const groupA: string[] = [];
  const groupB: string[] = [];
  if (headings.length === 0) return { groupA, groupB };

  const ref = headings[0].angle;
  for (const h of headings) {
    const diff = angleDiff(h.angle, ref);
    const diffOpposite = angleDiff(h.angle, ref + Math.PI);
    if (diff < Math.PI / 4 || diffOpposite < Math.PI / 4) {
      groupA.push(h.id);
    } else {
      groupB.push(h.id);
    }
  }
  return { groupA, groupB };
}

/**
 * True while every entry can still reach some destination and every destination can still be reached from some
 * entry. One-way conversions use this to refuse an edit that would strand traffic. A network with no entries or
 * no destinations has nothing to protect, so it passes.
 */
export function trafficStaysConnected(snapshot: NetworkSnapshot): boolean {
  const network = assembleNetwork(snapshot);
  const entries = network.edges.filter((e) => e.zone?.type === "entry");
  const dests = network.edges.filter((e) => e.zone?.type === "destination");
  if (entries.length === 0 || dests.length === 0) return true;
  const reaches = (from: Edge3D, targets: Edge3D[]) => targets.some((t) => t.id !== from.id && computeRoute(network, from.id, t.id));
  return entries.every((en) => reaches(en, dests)) && dests.every((d) => entries.some((en) => en.id !== d.id && computeRoute(network, en.id, d.id)));
}
