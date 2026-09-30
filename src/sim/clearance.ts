import * as THREE from "three";
import type { Edge3D, RoadNetwork } from "./types";

/** TxDOT minimum vertical clearance between a bridge deck and whatever passes beneath it, in feet. */
export const MIN_BRIDGE_CLEARANCE_FT = 16.5;

/** Distance between sampled points along an edge's centerline when hunting for plan-view crossings, in feet — fine enough to catch real crossings without being expensive on typical small networks. */
const SAMPLE_STEP_FT = 15;

export interface ClearanceViolation {
  edgeAId: string;
  edgeBId: string;
  /** Approximate world position of the crossing (averaged deck height of the two edges). */
  position: [number, number, number];
  /** Actual vertical separation between the two decks at the crossing, feet (can be negative if they'd physically collide). */
  clearanceFt: number;
}

interface SampledPoint {
  x: number;
  y: number;
  z: number;
}

function sampleEdge(edge: Edge3D): SampledPoint[] {
  const steps = Math.max(2, Math.round(edge.length / SAMPLE_STEP_FT));
  const points: SampledPoint[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    edge.spline.getPointAt(i / steps, p);
    points.push({ x: p.x, y: p.y, z: p.z });
  }
  return points;
}

/** 2D (x/z plane) segment intersection test — returns the interpolation fraction along each segment where they cross, or null if they don't. */
function segmentIntersect2D(
  a1: SampledPoint,
  a2: SampledPoint,
  b1: SampledPoint,
  b2: SampledPoint
): { tA: number; tB: number } | null {
  const d1x = a2.x - a1.x;
  const d1z = a2.z - a1.z;
  const d2x = b2.x - b1.x;
  const d2z = b2.z - b1.z;
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const dx = b1.x - a1.x;
  const dz = b1.z - a1.z;
  const tA = (dx * d2z - dz * d2x) / denom;
  const tB = (dx * d1z - dz * d1x) / denom;
  if (tA < 0 || tA > 1 || tB < 0 || tB > 1) return null;
  return { tA, tB };
}

function shareANode(a: Edge3D, b: Edge3D): boolean {
  return (
    a.fromNodeId === b.fromNodeId ||
    a.fromNodeId === b.toNodeId ||
    a.toNodeId === b.fromNodeId ||
    a.toNodeId === b.toNodeId
  );
}

function boundsOverlap(a: SampledPoint[], b: SampledPoint[]): boolean {
  let aMinX = Infinity, aMaxX = -Infinity, aMinZ = Infinity, aMaxZ = -Infinity;
  for (const p of a) {
    aMinX = Math.min(aMinX, p.x);
    aMaxX = Math.max(aMaxX, p.x);
    aMinZ = Math.min(aMinZ, p.z);
    aMaxZ = Math.max(aMaxZ, p.z);
  }
  let bMinX = Infinity, bMaxX = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;
  for (const p of b) {
    bMinX = Math.min(bMinX, p.x);
    bMaxX = Math.max(bMaxX, p.x);
    bMinZ = Math.min(bMinZ, p.z);
    bMaxZ = Math.max(bMaxZ, p.z);
  }
  return aMinX <= bMaxX && aMaxX >= bMinX && aMinZ <= bMaxZ && aMaxZ >= bMinZ;
}

/**
 * Finds every plan-view crossing between two unconnected road decks that
 * doesn't leave TxDOT's minimum 16.5 ft vertical clearance — e.g. a Tier 1
 * road passing just a few feet over an at-grade street. Edges that share an
 * endpoint (an ordinary junction, not a grade-separated crossing) are never
 * flagged. O(edges^2) with a bounding-box prune first, which is plenty fast
 * for the small hand-built networks this game deals with.
 */
export function findClearanceViolations(network: RoadNetwork): ClearanceViolation[] {
  const violations: ClearanceViolation[] = [];
  const edges = network.edges.filter((e) => !e.isRoundaboutRing);
  const sampledByEdge = new Map<string, SampledPoint[]>();
  for (const e of edges) sampledByEdge.set(e.id, sampleEdge(e));

  for (let i = 0; i < edges.length; i++) {
    const a = edges[i];
    const aPts = sampledByEdge.get(a.id)!;
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (shareANode(a, b)) continue;
      const bPts = sampledByEdge.get(b.id)!;
      if (!boundsOverlap(aPts, bPts)) continue;

      for (let si = 0; si < aPts.length - 1; si++) {
        let found = false;
        for (let sj = 0; sj < bPts.length - 1; sj++) {
          const hit = segmentIntersect2D(aPts[si], aPts[si + 1], bPts[sj], bPts[sj + 1]);
          if (!hit) continue;
          const yA = aPts[si].y + (aPts[si + 1].y - aPts[si].y) * hit.tA;
          const yB = bPts[sj].y + (bPts[sj + 1].y - bPts[sj].y) * hit.tB;
          const clearanceFt = Math.abs(yA - yB);
          if (clearanceFt < MIN_BRIDGE_CLEARANCE_FT) {
            const x = aPts[si].x + (aPts[si + 1].x - aPts[si].x) * hit.tA;
            const z = aPts[si].z + (aPts[si + 1].z - aPts[si].z) * hit.tA;
            violations.push({
              edgeAId: a.id,
              edgeBId: b.id,
              position: [x, (yA + yB) / 2, z],
              clearanceFt,
            });
          }
          found = true;
          break;
        }
        if (found) break; // one flagged crossing per edge pair is enough
      }
    }
  }

  return violations;
}
