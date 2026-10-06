"use client";

import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { assembleCached } from "@/sim/assembleCache";
import { carriagewayOffsetAt, edgePointAt, edgeRightVectorAt, edgeTangentAt, widthScaleAt } from "@/sim/laneGeometry";
import type { Edge3D } from "@/sim/types";
import { useEditorStore } from "@/state/editorStore";

/**
 * Where a road meets a roundabout: a raised splitter island between the entering and leaving carriageways (concrete,
 * with a kerb and a white edge line along the road side of it), and a dashed give-way line across each entry. Every
 * piece of every roundabout is merged into three meshes, so they cost three draw calls however many there are.
 */

const SHOULDER_FT = 4;
/** The island is drawn from the ring back to where the two carriageways have drawn this close together. */
const MIN_GAP_FT = 2.4;
const SAMPLE_FT = 5;
/** The island starts this far back from the ring's centreline, clear of the ring's own pavement. */
const RING_CLEARANCE_FT = 13;
/** Roads into and out of a roundabout that end this close together are the two sides of one arm. */
const PAIR_MAX_FT = 90;
/** Past this gap the two carriageways are different roads, not the sides of one island. */
const MAX_GAP_FT = 80;
const MAX_LENGTH_FT = 120;
const ISLAND_LIFT_FT = 0.35;
const KERB_LIFT_FT = 0.18;
const LINE_LIFT_FT = 0.08;
const KERB_WIDTH_FT = 0.9;
const LINE_WIDTH_FT = 0.45;
const YIELD_FROM_RING_FT = 9;
const YIELD_DASH_FT = 2.6;
const YIELD_GAP_FT = 2.2;
const YIELD_DEPTH_FT = 1.6;

const _right = new THREE.Vector3();
const _tan = new THREE.Vector3();

/** The inner (left-hand) edge of a carriageway's pavement at `distanceFt` along it. */
function innerEdge(edge: Edge3D, distanceFt: number, out: THREE.Vector3): THREE.Vector3 {
  const t = Math.min(1, Math.max(0, distanceFt / edge.length));
  edgePointAt(edge, t, out);
  edgeRightVectorAt(edge, t, _tan, _right);
  const k = widthScaleAt(edge, distanceFt);
  const half = ((edge.lanes * edge.laneWidthFt) / 2 + SHOULDER_FT) * k;
  out.addScaledVector(_right, carriagewayOffsetAt(edge, distanceFt, k) - half);
  if (out.y < 0) out.y = 0;
  return out;
}

/** One triangle, wound so it faces up whichever way the points run (a face the wrong way round is lit as if from below). */
function pushTri(positions: number[], p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, lift: number): void {
  const upward = (q.z - p.z) * (r.x - p.x) - (q.x - p.x) * (r.z - p.z);
  const [b, c] = upward >= 0 ? [q, r] : [r, q];
  for (const v of [p, b, c]) positions.push(v.x, v.y + lift, v.z);
}

/** Pushes a quad strip (two rails of points, joined to the next pair) onto the position list, raised by `lift`. */
function pushStrip(positions: number[], a: THREE.Vector3[], b: THREE.Vector3[], lift: number): void {
  for (let i = 0; i + 1 < a.length; i++) {
    pushTri(positions, a[i], b[i], b[i + 1], lift);
    pushTri(positions, a[i], b[i + 1], a[i + 1], lift);
  }
}

/** Moves each point of rail `from` a fixed distance toward the matching point of rail `toward`. */
function inset(from: THREE.Vector3[], toward: THREE.Vector3[], amount: number): THREE.Vector3[] {
  return from.map((p, i) => {
    const d = toward[i].clone().sub(p);
    d.y = 0;
    const len = d.length();
    return len < 1e-3 ? p.clone() : p.clone().addScaledVector(d, Math.min(amount, len * 0.45) / len);
  });
}

/** A ribbon of constant width along a rail of points, to one side of it. */
function pushRibbon(positions: number[], rail: THREE.Vector3[], towardSide: THREE.Vector3[], width: number, lift: number): void {
  const a: THREE.Vector3[] = rail.map((p) => p.clone());
  const b = inset(rail, towardSide, width);
  pushStrip(positions, a, b, lift);
}

export function buildRoundaboutDetails(edges: Edge3D[]): { island: THREE.BufferGeometry | null; kerb: THREE.BufferGeometry | null; lines: THREE.BufferGeometry | null } {
  const ringNodes = new Set<string>();
  for (const e of edges) if (e.isRoundaboutRing) (ringNodes.add(e.fromNodeId), ringNodes.add(e.toNodeId));
  if (ringNodes.size === 0) return { island: null, kerb: null, lines: null };

  const island: number[] = [];
  const kerb: number[] = [];
  const lines: number[] = [];
  // Each road into the ring is paired with the road that leaves it beside it: usually the other carriageway of the same
  // street, meeting the ring at the same node or the next one along, running the opposite way.
  const leaving = edges.filter((e) => !e.isRoundaboutRing && !e.isTexasTurnaround && ringNodes.has(e.fromNodeId) && e.length >= 40);
  const taken = new Set<Edge3D>();
  const pairFor = (into: Edge3D): Edge3D | undefined => {
    const a = edgePointAt(into, 1, new THREE.Vector3());
    const ta = edgeTangentAt(into, 1, new THREE.Vector3());
    let best: Edge3D | undefined;
    let bestD = PAIR_MAX_FT;
    for (const o of leaving) {
      if (taken.has(o)) continue;
      const b = edgePointAt(o, 0, new THREE.Vector3());
      const tb = edgeTangentAt(o, 0, new THREE.Vector3());
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      // Heading opposite ways, not crossing each other's line.
      if (d < bestD && ta.x * tb.x + ta.z * tb.z < -0.5) {
        best = o;
        bestD = d;
      }
    }
    if (best) taken.add(best);
    return best;
  };

  const p = new THREE.Vector3();
  for (const into of edges) {
    if (into.isRoundaboutRing || into.isTexasTurnaround || !ringNodes.has(into.toNodeId) || into.length < 40) continue;
    const out = pairFor(into);
    // The give-way line across the entry.
    {
      const d = into.length - YIELD_FROM_RING_FT;
      const t = d / into.length;
      edgePointAt(into, t, p);
      edgeRightVectorAt(into, t, _tan, _right);
      const k = widthScaleAt(into, d);
      const centre = carriagewayOffsetAt(into, d, k);
      const half = ((into.lanes * into.laneWidthFt) / 2) * k;
      const fwd = _tan.clone().setY(0).normalize();
      const right = _right.clone();
      const base = p.clone();
      if (base.y < 0) base.y = 0;
      for (let x = -half; x + YIELD_DASH_FT <= half + 1e-3; x += YIELD_DASH_FT + YIELD_GAP_FT) {
        const a = base.clone().addScaledVector(right, centre + x);
        const b = base.clone().addScaledVector(right, centre + x + YIELD_DASH_FT);
        const a2 = a.clone().addScaledVector(fwd, YIELD_DEPTH_FT);
        const b2 = b.clone().addScaledVector(fwd, YIELD_DEPTH_FT);
        pushTri(lines, a, b, b2, LINE_LIFT_FT);
        pushTri(lines, a, b2, a2, LINE_LIFT_FT);
      }
    }
    if (!out || out.length < 40) continue;

    // The island lies between the two carriageways' inner edges. Walk back from the ring until they come together.
    const railIn: THREE.Vector3[] = [];
    const railOut: THREE.Vector3[] = [];
    const limit = Math.min(MAX_LENGTH_FT, into.length * 0.6, out.length * 0.6);
    for (let d = RING_CLEARANCE_FT; d <= limit; d += SAMPLE_FT) {
      const a = innerEdge(into, into.length - d, new THREE.Vector3());
      const b = innerEdge(out, d, new THREE.Vector3());
      const gap = a.distanceTo(b);
      if (railIn.length === 0 && gap > MAX_GAP_FT) break;
      if (gap < MIN_GAP_FT && railIn.length > 0) break;
      railIn.push(a);
      railOut.push(b);
    }
    if (railIn.length < 3) continue;
    // The kerb is the whole gap; the island sits inside it, the white line along the road side of the kerb.
    pushStrip(kerb, railIn, railOut, KERB_LIFT_FT);
    const innerA = inset(railIn, railOut, KERB_WIDTH_FT);
    const innerB = inset(railOut, railIn, KERB_WIDTH_FT);
    pushStrip(island, innerA, innerB, ISLAND_LIFT_FT);
    pushRibbon(lines, railIn.map((q) => q.clone().setY(q.y)), railOut, -LINE_WIDTH_FT, LINE_LIFT_FT);
    pushRibbon(lines, railOut.map((q) => q.clone().setY(q.y)), railIn, -LINE_WIDTH_FT, LINE_LIFT_FT);
  }

  const make = (positions: number[]): THREE.BufferGeometry | null => {
    if (positions.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  return { island: make(island), kerb: make(kerb), lines: make(lines) };
}

function RoundaboutDetails() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const network = useMemo(() => assembleCached(nodes, edges), [nodes, edges]);
  const parts = useMemo(() => buildRoundaboutDetails(network.edges), [network]);
  useEffect(
    () => () => {
      parts.island?.dispose();
      parts.kerb?.dispose();
      parts.lines?.dispose();
    },
    [parts],
  );
  return (
    <group>
      {parts.kerb && (
        <mesh geometry={parts.kerb} receiveShadow>
          <meshStandardMaterial color="#8f8c85" roughness={0.9} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      )}
      {parts.island && (
        <mesh geometry={parts.island} receiveShadow>
          <meshStandardMaterial color="#c8c5bb" roughness={0.9} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-3} polygonOffsetUnits={-3} />
        </mesh>
      )}
      {parts.lines && (
        <mesh geometry={parts.lines}>
          <meshStandardMaterial color="#f4f4f5" roughness={0.5} emissive="#f4f4f5" emissiveIntensity={0.12} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
        </mesh>
      )}
    </group>
  );
}

export default memo(RoundaboutDetails);
