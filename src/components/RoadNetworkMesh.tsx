"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Html, Line } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { assembleNetwork, assembleNetworkCached, planTexasTurnaround, type TexasTurnaroundPlan } from "@/sim/network";
import { findClearanceViolations, MIN_BRIDGE_CLEARANCE_FT, type ClearanceViolation } from "@/sim/clearance";
import { ROAD_CLASSES } from "@/sim/roadClasses";
import { useEditorStore } from "@/state/editorStore";
import { getPrefs } from "@/lib/prefs";
import { usePhotoMode } from "@/lib/photoMode";
import type { ContractStatus, Edge3D, EdgeSpeedRatio, NetworkSnapshot, NodeSpec } from "@/sim/types";
import { badgeColorForIndex } from "./hud/badgeColors";
import { IconWarning } from "./hud/icons";
import {
  buildAsphaltRibbon,
  buildCrosswalkBars,
  buildDashedStripe,
  buildExpansionJoint,
  buildGroundShadowRibbon,
  buildJerseyBarrier,
  buildLaneArrows,
  buildParapet,
  buildSolidStripe,
  buildStopBar,
  buildGores,
  buildTaperedPierColumn,
  computePierDescriptors,
  indexPierConflicts,
  visibleRanges,
  type PierDescriptor,
} from "./roadGeometry";

/** How long a freshly built road takes to rise into place. */
const BUILD_RISE_MS = 520;

const ASPHALT_COLOR = "#3a4155";
const ASPHALT_SELECTED_COLOR = "#4a6a8f";
const ROUNDABOUT_COLOR = "#434b60";
const ROUNDABOUT_SELECTED_COLOR = "#4e6f92";
const TEXAS_TURNAROUND_COLOR = "#8a4a2f";
const TEXAS_TURNAROUND_SELECTED_COLOR = "#a85a3a";
const WHITE_COLOR = "#f4f4f5";
const YELLOW_COLOR = "#eab308";
const BUS_LANE_COLOR = "#b4432f";
const BIKE_LANE_COLOR = "#2f9e5b";
const BARRIER_COLOR = "#9a9aa0";
const PIER_COLOR = "#75757c";
const DECK_UNDERSIDE_COLOR = "#5a5a62";
const JOINT_COLOR = "#232326";
const ABUTMENT_COLOR = "#7d7d84";
const SHOULDER_FT = 4;
/** How far the paved slab is extruded downward for an elevated edge, so bridges read as a real structure instead of a floating plane. */
const DECK_THICKNESS_FT = 2.5;

// Blue -> amber -> red (never green) so the heatmap stays readable for
// red-green colorblind players — see matching comment in sim/worker.ts.
const HEATMAP_FREE = new THREE.Color("#3b82f6");
const HEATMAP_SLOW = new THREE.Color("#eab308");
const HEATMAP_STOP = new THREE.Color("#ef4444");
const _heatmapColor = new THREE.Color();

function heatmapColorHex(ratio: number): string {
  const r = Math.max(0, Math.min(1.2, ratio));
  if (r >= 0.75) _heatmapColor.copy(HEATMAP_FREE);
  else if (r <= 0.2) _heatmapColor.copy(HEATMAP_STOP);
  else if (r <= 0.5) _heatmapColor.lerpColors(HEATMAP_STOP, HEATMAP_SLOW, (r - 0.2) / 0.3);
  else _heatmapColor.lerpColors(HEATMAP_SLOW, HEATMAP_FREE, (r - 0.5) / 0.25);
  return `#${_heatmapColor.getHexString()}`;
}

interface StripeSpec {
  geometry: THREE.BufferGeometry;
  color: string;
}

interface AbutmentDescriptor {
  position: [number, number, number];
  rotationY: number;
  halfWidth: number;
  heightFt: number;
}

interface EdgeGeometries {
  ribbon: THREE.BufferGeometry;
  /** A flat strip laid on the ground over the stretch of this edge that runs underground, so cuttings and tunnels stay visible from above. Null for at-grade and raised edges. */
  belowGradeOverlay: THREE.BufferGeometry | null;
  stripes: StripeSpec[];
  barriers: THREE.BufferGeometry[];
  parapets: THREE.BufferGeometry[];
  piers: PierDescriptor[];
  pierColumnGeometries: THREE.BufferGeometry[];
  markingMeshes: THREE.BufferGeometry[];
  groundShadow: THREE.BufferGeometry | null;
  expansionJoints: THREE.BufferGeometry[];
  abutments: AbutmentDescriptor[];
  startPoint: THREE.Vector3;
  endPoint: THREE.Vector3;
}

/** Half-width (ft) of a pier column just under the cap beam. */
const PIER_COLUMN_TOP_HALF_WIDTH_FT = 1.1;
/** Half-width (ft) of a pier column at its footing — wider than the top, like a real tapered bent. */
const PIER_COLUMN_BASE_HALF_WIDTH_FT = 1.7;

/** Lateral half-gap (ft) between the two painted lines of a centerline, undivided two-way roads. */
const CENTERLINE_GAP_FT = 0.3;

/**
 * The terrain is a solid plane, so a cutting or tunnel would simply vanish beneath it (leaving only a few
 * barrier rails poking through). This lays a ground-level strip over just the underground stretch — the real
 * ribbon still runs below it — so the player can see where the road dives and where it surfaces.
 */
/** The lowest point of an edge's centreline. */
function edgeMinY(edge: Edge3D): number {
  let minY = Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i <= 24; i++) {
    edge.spline.getPointAt(i / 24, p);
    minY = Math.min(minY, p.y);
  }
  return minY;
}

function buildBelowGradeOverlay(edge: Edge3D): THREE.BufferGeometry | null {
  // Only a real cutting or underpass (see Edge3D.sunken) needs the flat overlay; a few tenths of a foot of overshoot does not.
  if (!edge.sunken) return null;
  const geo = buildAsphaltRibbon(edge, SHOULDER_FT + 2, 0);
  const pos = geo.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, Math.max(pos.getY(i), 0) + 0.18);
  }
  pos.needsUpdate = true;
  return geo;
}

function buildEdgeGeometries(edge: Edge3D, isTwoWay: boolean, hasStopBar: boolean, hasCrosswalk: boolean): EdgeGeometries {
  const pavedHalfWidth = (edge.lanes * edge.laneWidthFt) / 2;
  const ribbon = buildAsphaltRibbon(edge, SHOULDER_FT, edge.isElevated ? DECK_THICKNESS_FT : 0);
  const roadClass = ROAD_CLASSES[edge.roadClassId];
  const isCenterlineEdge = isTwoWay && !edge.isRoundaboutRing && !edge.isTexasTurnaround;

  // Where a road merges into, diverges from or crosses others, barriers and edge lines stop short rather than running
  // across the lanes of the road it joins.
  const JUNCTION_TRIM_FT = 45;
  const EDGE_LINE_TRIM_FT = 16;
  const trimRange = (ft: number): [number, number] =>
    edge.length > ft * 3 ? [edge.startsAtJunction ? ft / edge.length : 0, edge.endsAtJunction ? 1 - ft / edge.length : 1] : [0, 1];
  const [barT0, barT1] = trimRange(JUNCTION_TRIM_FT);
  const [lineT0, lineT1] = trimRange(EDGE_LINE_TRIM_FT);
  /** The stretches of a line or barrier at this offset that are not lying on another road's pavement, within [lo, hi]. */
  const runs = (offset: number, lo: number, hi: number): [number, number][] =>
    visibleRanges(edge, offset)
      .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number])
      .filter(([a, b]) => (b - a) * edge.length > 12);

  const stripes: StripeSpec[] = [];
  // The ramp's edge line on the side facing the through road is left out where the two run hard together (an added
  // lane): the through road's own edge line is the boundary there.
  const innerSide = edge.padStart?.awaySign ?? edge.padEnd?.awaySign;
  const adjStart = edge.padStart ? edge.padStart.adjacentUntil / edge.length : 0;
  const adjEnd = edge.padEnd ? 1 - edge.padEnd.adjacentUntil / edge.length : 1;
  // Gore wedges where this road splits from, or merges into, a bigger one.
  for (const gore of buildGores(edge)) {
    stripes.push({ geometry: gore.pave, color: ASPHALT_COLOR });
    stripes.push({ geometry: gore.hatching, color: WHITE_COLOR });
  }
  // On an undivided two-way road this carriageway's left edge is the road's centerline: a double yellow line
  // (the opposite carriageway draws the same one from its side). Everywhere else it is a plain white edge line.
  const leftIsCenterline = isCenterlineEdge && !roadClass.divided;
  if (leftIsCenterline) {
    // The double yellow stops short of a junction, so it never runs on into a roundabout's lanes or across a crossing road.
    const [cT0, cT1] = trimRange(28);
    for (const off of [-pavedHalfWidth - CENTERLINE_GAP_FT, -pavedHalfWidth + CENTERLINE_GAP_FT]) {
      stripes.push({ geometry: buildSolidStripe(edge, off, 0.35, 0.03, cT0, cT1), color: YELLOW_COLOR });
    }
  } else {
    const lo = innerSide === -1 ? Math.max(lineT0, adjStart) : lineT0;
    const hi = innerSide === -1 ? Math.min(lineT1, adjEnd) : lineT1;
    for (const [a, b] of runs(-pavedHalfWidth, lo, hi)) {
      stripes.push({ geometry: buildSolidStripe(edge, -pavedHalfWidth, 0.5, 0.03, a, b), color: WHITE_COLOR });
    }
  }
  {
    const lo = innerSide === 1 ? Math.max(lineT0, adjStart) : lineT0;
    const hi = innerSide === 1 ? Math.min(lineT1, adjEnd) : lineT1;
    for (const [a, b] of runs(pavedHalfWidth, lo, hi)) {
      stripes.push({ geometry: buildSolidStripe(edge, pavedHalfWidth, 0.5, 0.03, a, b), color: WHITE_COLOR });
    }
  }

  for (let k = 1; k < edge.lanes; k++) {
    const offset = (k - edge.lanes / 2) * edge.laneWidthFt;
    stripes.push({ geometry: buildDashedStripe(edge, offset), color: WHITE_COLOR });
  }

  // A lane set aside for buses or bikes is painted its own colour, so the player can read it at a glance.
  if (edge.reservedLane && edge.length > 20) {
    const center = (edge.lanes - 0.5 - edge.lanes / 2) * edge.laneWidthFt;
    stripes.push({
      geometry: buildSolidStripe(edge, center, edge.laneWidthFt - 1.4, 0.022),
      color: edge.reservedLane === "bus" ? BUS_LANE_COLOR : BIKE_LANE_COLOR,
    });
  }

  if (edge.isFreeway) {
    for (const off of [-(pavedHalfWidth + 1.0), -(pavedHalfWidth + 1.7)]) {
      for (const [a, b] of runs(off, barT0, barT1)) {
        stripes.push({ geometry: buildSolidStripe(edge, off, 0.4, 0.03, a, b), color: YELLOW_COLOR });
      }
    }
  }

  if (edge.length > 90) {
    for (let lane = 0; lane < edge.lanes; lane++) {
      // One arrowhead per permitted move, so a shared left+straight lane reads as a fork.
      for (const move of edge.laneMoves[lane] ?? ["straight"]) {
        const turnBias = move === "left" ? -1 : move === "right" ? 1 : 0;
        stripes.push({ geometry: buildLaneArrows(edge, lane, 140, 16, 5, 0.04, turnBias), color: WHITE_COLOR });
      }
    }
  }

  const barriers: THREE.BufferGeometry[] = [];
  const parapets: THREE.BufferGeometry[] = [];
  // A road that runs below the grass has no barriers to show: their tops would poke through as stray lines.
  const sunken = edge.sunken;
  if (sunken) {
    // nothing
  } else if (edge.isFreeway) {
    // Freeways keep the heavier F-shape Jersey barrier at grade or elevated.
    const barrierOffset = pavedHalfWidth + SHOULDER_FT - 0.5;
    for (const off of [-barrierOffset, barrierOffset]) {
      for (const [a, b] of runs(off, barT0, barT1)) barriers.push(buildJerseyBarrier(edge, off, a, b));
    }
  } else if (edge.isElevated && !edge.isRoundaboutRing) {
    // A raised non-freeway road (a Tier-1+ street/avenue) still has a real
    // fall hazard along its exposed edge — give it a plainer concrete
    // parapet rail instead of leaving the drop-off unguarded.
    const parapetOffset = pavedHalfWidth + 0.5;
    for (const off of [-parapetOffset, parapetOffset]) {
      for (const [a, b] of runs(off, barT0, barT1)) parapets.push(buildParapet(edge, off, a, b));
    }
  }

  const markingMeshes: THREE.BufferGeometry[] = [];
  const canMarkJunction = !edge.isRoundaboutRing && edge.length > 25;
  if (canMarkJunction && hasStopBar) markingMeshes.push(buildStopBar(edge));
  if (canMarkJunction && hasCrosswalk) markingMeshes.push(...buildCrosswalkBars(edge));
  // A mid-block crossing sits halfway along the segment.
  if (edge.crosswalk && edge.length > 60) markingMeshes.push(...buildCrosswalkBars(edge, edge.length / 2 - 7, 14, 3.2, 2));

  const piers = computePierDescriptors(edge);
  const pierColumnGeometries = piers.map((pier) =>
    buildTaperedPierColumn(PIER_COLUMN_TOP_HALF_WIDTH_FT, PIER_COLUMN_BASE_HALF_WIDTH_FT, pier.columnHeight)
  );
  const startPoint = edge.spline.getPointAt(0);
  const endPoint = edge.spline.getPointAt(1);

  const belowGradeOverlay = buildBelowGradeOverlay(edge);
  const groundShadow = edge.isElevated ? buildGroundShadowRibbon(edge) : null;
  // One expansion joint per pier — that's exactly where a real bridge deck
  // is segmented, so reusing the pier spacing keeps the two in lockstep for
  // free instead of computing a second, independent interval.
  const expansionJoints = edge.isElevated ? piers.map((pier) => buildExpansionJoint(edge, pier.distanceFt)) : [];

  const abutments: AbutmentDescriptor[] = [];
  if (edge.isElevated && !edge.isRoundaboutRing) {
    const abutmentHalfWidth = pavedHalfWidth + SHOULDER_FT;
    // The deck sits to this carriageway's side of the centerline, and so must its abutment walls.
    const shiftAt = (t: number, p: THREE.Vector3): [number, number] => {
      const tan = edge.spline.getTangentAt(t);
      const len = Math.hypot(tan.x, tan.z) || 1;
      return [p.x + (-tan.z / len) * edge.lateralShiftFt, p.z + (tan.x / len) * edge.lateralShiftFt];
    };
    if (startPoint.y > 2) {
      // no abutment: this end continues from an already-elevated point
      // (an interior joint of a longer elevated corridor — a pier belongs
      // there, not a ground transition wall)
    } else {
      const tangent = edge.spline.getTangentAt(0);
      const heightFt = Math.max(DECK_THICKNESS_FT + 1, edge.spline.getPointAt(0.02).y);
      const [sx, sz] = shiftAt(0, startPoint);
      abutments.push({
        position: [sx, heightFt / 2, sz],
        rotationY: Math.atan2(tangent.x, tangent.z),
        halfWidth: abutmentHalfWidth,
        heightFt,
      });
    }
    if (endPoint.y <= 2) {
      const tangent = edge.spline.getTangentAt(1);
      const heightFt = Math.max(DECK_THICKNESS_FT + 1, edge.spline.getPointAt(0.98).y);
      const [ex, ez] = shiftAt(1, endPoint);
      abutments.push({
        position: [ex, heightFt / 2, ez],
        rotationY: Math.atan2(tangent.x, tangent.z),
        halfWidth: abutmentHalfWidth,
        heightFt,
      });
    }
  }

  return {
    ribbon,
    belowGradeOverlay,
    stripes,
    barriers,
    parapets,
    piers,
    pierColumnGeometries,
    markingMeshes,
    groundShadow,
    expansionJoints,
    abutments,
    startPoint,
    endPoint,
  };
}

const ZoneBadge = memo(function ZoneBadge({
  edge,
  badgeIndex,
  typeIndex,
  contract,
  compact,
  hidden,
}: {
  /** Hidden (not unmounted: these overlays don't survive being removed) while photo mode is on. */
  hidden?: boolean;
  edge: Edge3D;
  badgeIndex: number;
  typeIndex: number;
  contract?: ContractStatus;
  /** Real cities have 20+ zones; a small lettered pin keeps the map readable when zoomed out. */
  compact?: boolean;
}) {
  if (!edge.zone) return null;
  const isEntry = edge.zone.type === "entry";
  const p = edge.spline.getPointAt(isEntry ? 0 : 1);
  const color = badgeColorForIndex(badgeIndex);
  const label = compact ? `${isEntry ? "E" : "D"}${typeIndex + 1}` : isEntry ? `Entry ${typeIndex + 1}` : `Dest ${typeIndex + 1}`;

  let statusColor: string | null = null;
  if (!isEntry) {
    statusColor = !contract || contract.sampleCount === 0 ? "#9ca3af" : contract.meetsThreshold ? "#3b82f6" : "#ef4444";
  }

  return (
    <Html position={[p.x, p.y, p.z]} style={{ pointerEvents: "none", display: hidden ? "none" : undefined }} zIndexRange={[10, 0]} occlude={false}>
      <div style={{ position: "relative", transform: "translate(-50%, -100%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div
          style={{
            background: color,
            color: "#fff",
            fontSize: compact ? 9 : 11,
            fontWeight: 700,
            padding: compact ? "1px 5px" : "3px 9px",
            borderRadius: 7,
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
            border: "1.5px solid rgba(255,255,255,0.55)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {label}
        </div>
        <div style={{ width: 2, height: compact ? 10 : 24, background: color }} />
        {statusColor && (
          <div
            style={{
              position: "absolute",
              bottom: -3,
              left: "50%",
              transform: "translateX(-50%)",
              width: 9,
              height: 9,
              borderRadius: 999,
              background: statusColor,
              border: "1.5px solid white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
            }}
          />
        )}
      </div>
    </Html>
  );
});

/** A pulsing "trouble here" marker over an edge that's been badly congested for a while — the game's "find the problem" signal, on by default (unlike the opt-in heatmap). */
const ProblemMarker = memo(function ProblemMarker({ edge }: { edge: Edge3D }) {
  const p = edge.spline.getPointAt(0.5);
  return (
    <Html position={[p.x, p.y, p.z]} style={{ pointerEvents: "none" }} zIndexRange={[15, 0]} occlude={false}>
      <div
        className="animate-warn-pulse"
        style={{
          transform: "translate(-50%, -130%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          borderRadius: 999,
          background: "linear-gradient(180deg, #fb923c, #ea580c)",
          border: "2px solid #7c2d12",
        }}
        title="Badly congested"
      >
        <IconWarning style={{ width: 15, height: 15 }} />
      </div>
    </Html>
  );
});

/** A pulsing red exclamation over a vehicle that's been near-stationary long enough to be flagged as gridlocked — it despawns for a throughput penalty shortly after this appears. */
const GridlockMarker = memo(function GridlockMarker({ position }: { position: [number, number, number] }) {
  return (
    <Html
      position={[position[0], position[1] + 8, position[2]]}
      style={{ pointerEvents: "none" }}
      zIndexRange={[15, 0]}
      occlude={false}
    >
      <div
        className="animate-warn-pulse"
        style={{
          transform: "translate(-50%, -130%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: 999,
          background: "linear-gradient(180deg, #f87171, #dc2626)",
          border: "2px solid #7f1d1d",
        }}
        title="Gridlocked — about to give up"
      >
        <IconWarning style={{ width: 13, height: 13 }} />
      </div>
    </Html>
  );
});

/** Radius/height (ft) of the invisible click target that makes a junction selectable for the Simulate-mode civil metrics panel — a bit larger than Build mode's visible node marker since there's no colored disc here to aim at. */
const NODE_INSPECT_HIT_RADIUS_FT = 9;
const NODE_INSPECT_HIT_HEIGHT_FT = 2;

/**
 * An invisible click target at a junction, active only in Simulate mode.
 * RoadEditor (the source of Build mode's clickable, colored node markers)
 * unmounts entirely once traffic is opened so the network reads as
 * "finished," which otherwise leaves junctions with no way to select them
 * for LiveNodeInspector — this fills that gap without reintroducing any of
 * Build mode's editing affordances.
 */
const NodeInspectTarget = memo(function NodeInspectTarget({ node }: { node: NodeSpec }) {
  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const store = useEditorStore.getState();
    if (store.tool === "inspect" || store.tool === "junction") {
      store.setSelection({ kind: "node", id: node.id });
    }
  };
  return (
    <mesh
      position={[node.position[0], node.position[1] + NODE_INSPECT_HIT_HEIGHT_FT / 2, node.position[2]]}
      onClick={handleClick}
    >
      <cylinderGeometry args={[NODE_INSPECT_HIT_RADIUS_FT, NODE_INSPECT_HIT_RADIUS_FT, NODE_INSPECT_HIT_HEIGHT_FT, 16]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
});

/** Flags a plan-view road crossing that doesn't clear TxDOT's 16.5 ft minimum bridge clearance. */
function ClearanceWarningMarker({ violation }: { violation: ClearanceViolation }) {
  return (
    <Html
      position={violation.position}
      style={{ pointerEvents: "none" }}
      zIndexRange={[16, 0]}
      occlude={false}
    >
      <div
        className="animate-warn-pulse"
        style={{
          transform: "translate(-50%, -130%)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "3px 8px",
          borderRadius: 999,
          background: "linear-gradient(180deg, #fbbf24, #b45309)",
          border: "2px solid #78350f",
          color: "#fff",
          fontSize: 10,
          fontWeight: 800,
          whiteSpace: "nowrap",
          fontFamily: "var(--font-sans)",
        }}
        title={`Only ${violation.clearanceFt.toFixed(1)} ft clearance — needs ${MIN_BRIDGE_CLEARANCE_FT} ft`}
      >
        <IconWarning style={{ width: 12, height: 12 }} />
        {violation.clearanceFt.toFixed(1)} ft clearance
      </div>
    </Html>
  );
}

/** A translucent preview of the loop a Texas turnaround would create — shown while hovering an eligible frontage road with the Turnaround tool active. */
function TurnaroundPreview({ plan }: { plan: TexasTurnaroundPlan }) {
  const points: [number, number, number][] = [
    plan.nodeAPoint,
    plan.controlPoint1,
    plan.controlPoint2,
    plan.nodeBPoint,
  ].map((p) => [p[0], p[1] + 1.5, p[2]] as [number, number, number]);

  return (
    <group>
      <Line points={points} color="#e08a4f" lineWidth={4} dashed dashScale={3} transparent opacity={0.85} />
      {[plan.nodeAPoint, plan.nodeBPoint].map((p, i) => (
        <mesh key={i} position={[p[0], p[1] + 1.5, p[2]]}>
          <sphereGeometry args={[3, 12, 12]} />
          <meshStandardMaterial color="#e08a4f" emissive="#e08a4f" emissiveIntensity={0.5} transparent opacity={0.85} />
        </mesh>
      ))}
    </group>
  );
}

const YieldMarker = memo(function YieldMarker({ edge }: { edge: Edge3D }) {
  const p = edge.spline.getPointAt(1);
  const tangent = edge.spline.getTangentAt(1);
  const rotationY = Math.atan2(tangent.x, tangent.z);
  return (
    <mesh position={[p.x, p.y + 0.1, p.z]} rotation={[-Math.PI / 2, 0, rotationY]}>
      <coneGeometry args={[3.2, 0.4, 3]} />
      <meshStandardMaterial color="#f4f4f5" emissive="#f4f4f5" emissiveIntensity={0.15} />
    </mesh>
  );
});

const EdgeGroup = memo(function EdgeGroup({
  edge,
  badgeIndex,
  typeIndex,
  speedRatio,
  turnaroundHighlight,
  onTurnaroundHover,
  isTwoWay,
  hasStopBar,
  hasCrosswalk,
  decorative,
  animateIn,
}: {
  decorative?: boolean;
  /** True once the initial load has settled: a road that mounts after that was just built, so it rises out of the ground. */
  animateIn?: boolean;
  edge: Edge3D;
  badgeIndex?: number;
  typeIndex?: number;
  speedRatio?: number;
  turnaroundHighlight?: boolean;
  onTurnaroundHover?: (edgeId: string | null, point: THREE.Vector3 | null) => void;
  isTwoWay: boolean;
  hasStopBar: boolean;
  hasCrosswalk: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  // animateIn is captured once, at mount: later changes to it must not retrigger roads that already exist.
  const animateAtMount = useRef(animateIn && !getPrefs().reducedMotion);
  const bornAt = useRef<number | null>(null);
  const centerXZ = useRef<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    if (!animateAtMount.current || !groupRef.current) return;
    const mid = edge.spline.getPointAt(0.5);
    centerXZ.current = [mid.x, mid.z];
    groupRef.current.scale.setScalar(0.02);
    groupRef.current.position.set(mid.x * 0.98, 0, mid.z * 0.98);
    bornAt.current = performance.now();
    // Mount only: re-running when the edge object is rebuilt (e.g. after a speed-limit edit) would replay the build animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFrame(() => {
    const g = groupRef.current;
    const born = bornAt.current;
    if (!g || born === null) return;
    const t = Math.min(1, (performance.now() - born) / BUILD_RISE_MS);
    if (t >= 1) {
      g.scale.setScalar(1);
      g.position.set(0, 0, 0);
      bornAt.current = null;
      return;
    }
    // Grow outward from the road's midpoint with a little overshoot, so a new road snaps into place with a
    // satisfying settle. (Scaling about the midpoint, not just in height, is what makes a flat road visibly animate.)
    const c = 1.70158;
    const s = Math.max(0.02, 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2));
    g.scale.setScalar(s);
    const [cx, cz] = centerXZ.current;
    g.position.set(cx * (1 - s), 0, cz * (1 - s));
  });

  const geometries = useMemo(
    () => buildEdgeGeometries(edge, isTwoWay, hasStopBar, hasCrosswalk),
    [edge, isTwoWay, hasStopBar, hasCrosswalk]
  );
  const isSelected = useEditorStore(
    (s) => s.selection?.kind === "edge" && s.selection.id === edge.id
  );
  const heatmapEnabled = useEditorStore((s) => s.heatmapEnabled);
  const mode = useEditorStore((s) => s.mode);
  const showHeatmap = heatmapEnabled && mode === "simulate" && speedRatio !== undefined && !edge.isRoundaboutRing;

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const store = useEditorStore.getState();
    const point: [number, number, number] = [event.point.x, event.point.y, event.point.z];

    // Traffic Manager tools just select a road, in either mode.
    if (store.tool === "transit") {
      store.extendTransit(edge.id);
      return;
    }
    if (store.tool === "lanes" || store.tool === "speed" || store.tool === "street") {
      store.setSelection({ kind: "edge", id: edge.id });
      return;
    }

    if (store.tool === "delete") {
      store.deleteEdge(edge.id);
    } else if (store.tool === "inspect") {
      store.setSelection({ kind: "edge", id: edge.id });
    } else if (store.tool === "zone") {
      store.cycleEdgeZone(edge.id);
    } else if (store.tool === "turnaround") {
      store.createTexasTurnaround(edge.id, point);
    } else if (store.tool === "draw") {
      const splitNodeId = store.splitEdgeAt(edge.id, point);
      if (store.drawFromNodeId) {
        store.drawTo(store.drawFromNodeId, splitNodeId, point);
      } else {
        store.startDrawChain(splitNodeId);
      }
    }
  };

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!onTurnaroundHover || useEditorStore.getState().tool !== "turnaround") return;
    event.stopPropagation();
    onTurnaroundHover(edge.id, event.point.clone());
  };

  const handlePointerOut = () => {
    if (!onTurnaroundHover || useEditorStore.getState().tool !== "turnaround") return;
    onTurnaroundHover(null, null);
  };

  return (
    <group ref={groupRef}>
      <mesh
        geometry={geometries.ribbon}
        receiveShadow
        onClick={decorative ? undefined : handleClick}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
      >
        <meshStandardMaterial
          color={
            edge.isRoundaboutRing
              ? isSelected
                ? ROUNDABOUT_SELECTED_COLOR
                : ROUNDABOUT_COLOR
              : edge.isTexasTurnaround
                ? isSelected
                  ? TEXAS_TURNAROUND_SELECTED_COLOR
                  : TEXAS_TURNAROUND_COLOR
                : turnaroundHighlight
                  ? "#e08a4f"
                  : showHeatmap
                    ? heatmapColorHex(speedRatio!)
                    : isSelected
                      ? ASPHALT_SELECTED_COLOR
                      : ASPHALT_COLOR
          }
          roughness={0.95}
          metalness={0.05}
        />
      </mesh>

      {geometries.belowGradeOverlay && (
        <mesh geometry={geometries.belowGradeOverlay} renderOrder={3}>
          <meshBasicMaterial
            // Excavation reads warm brown, a tunnel cool slate — the same coding the elevation picker uses.
            color={edge.elevationLevelId === "tunnel" ? "#5f6b85" : "#9a7a52"}
            transparent
            opacity={0.62}
            depthWrite={false}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      )}

      {geometries.stripes.map((stripe, i) => (
        <mesh key={i} geometry={stripe.geometry} receiveShadow={false}>
          <meshStandardMaterial
            color={stripe.color}
            roughness={0.5}
            emissive={stripe.color}
            emissiveIntensity={0.12}
          />
        </mesh>
      ))}

      {geometries.markingMeshes.map((geo, i) => (
        <mesh key={i} geometry={geo} receiveShadow={false}>
          <meshStandardMaterial color={WHITE_COLOR} roughness={0.5} emissive={WHITE_COLOR} emissiveIntensity={0.12} />
        </mesh>
      ))}

      {geometries.barriers.map((geo, i) => (
        <mesh key={i} geometry={geo} castShadow receiveShadow>
          <meshStandardMaterial color={BARRIER_COLOR} roughness={0.85} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {geometries.parapets.map((geo, i) => (
        <mesh key={i} geometry={geo} castShadow receiveShadow>
          <meshStandardMaterial color={BARRIER_COLOR} roughness={0.88} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {geometries.expansionJoints.map((geo, i) => (
        <mesh key={i} geometry={geo}>
          <meshStandardMaterial color={JOINT_COLOR} roughness={0.7} />
        </mesh>
      ))}

      {geometries.groundShadow && (
        <mesh geometry={geometries.groundShadow}>
          <meshBasicMaterial color="#000000" transparent opacity={0.22} depthWrite={false} />
        </mesh>
      )}

      {geometries.abutments.map((abutment, i) => (
        <mesh
          key={i}
          position={abutment.position}
          rotation={[0, abutment.rotationY, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[abutment.halfWidth * 2, abutment.heightFt, 3]} />
          <meshStandardMaterial color={ABUTMENT_COLOR} roughness={0.9} />
        </mesh>
      ))}

      {geometries.piers.map((pier, i) => {
        const columnTopY = pier.capPosition[1] - 1;
        return (
          <group key={i} position={pier.capPosition} rotation={[0, pier.rotationY, 0]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[pier.capLength, 2, 3.5]} />
              <meshStandardMaterial color={PIER_COLOR} roughness={0.92} />
            </mesh>
            {pier.columnOffsets.map((offset, ci) => (
              <mesh
                key={ci}
                castShadow
                receiveShadow
                position={[offset, -(columnTopY / 2 + 1), 0]}
                geometry={geometries.pierColumnGeometries[i]}
              >
                <meshStandardMaterial color={PIER_COLOR} roughness={0.92} />
              </mesh>
            ))}
          </group>
        );
      })}

    </group>
  );
});

function quantizeRatio(ratio: number | undefined): number | undefined {
  return ratio === undefined ? undefined : Math.round(ratio * 20) / 20;
}

export default function RoadNetworkMesh({
  contracts,
  edgeSpeedRatios,
  problemEdgeIds,
  gridlockMarkers,
  incidentMarkers,
  networkOverride,
}: {
  /** Render this fixed network instead of the editor's (used by the landing page): no zone badges, not clickable. */
  networkOverride?: NetworkSnapshot;
  contracts?: ContractStatus[];
  edgeSpeedRatios?: EdgeSpeedRatio[];
  problemEdgeIds?: string[];
  gridlockMarkers?: [number, number, number][];
  incidentMarkers?: [number, number, number][];
}) {
  const storeNodes = useEditorStore((s) => s.nodes);
  const storeEdges = useEditorStore((s) => s.edges);
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const heatmapEnabled = useEditorStore((s) => s.heatmapEnabled);
  const hideClearanceWarnings = useEditorStore((s) => s.realCityActive);
  const photo = usePhotoMode();
  const nodes = networkOverride?.nodes ?? storeNodes;
  const edges = networkOverride?.edges ?? storeEdges;
  const decorative = networkOverride !== undefined;

  const network = useMemo(() => {
    const assembled = decorative ? assembleNetwork({ nodes, edges }) : assembleNetworkCached(nodes, edges);
    // Leave out the bridge piers that would stand in the lanes of a road below.
    indexPierConflicts(assembled.edges);
    return assembled;
  }, [nodes, edges, decorative]);

  const [turnaroundHover, setTurnaroundHover] = useState<{ edgeId: string; point: THREE.Vector3 } | null>(null);
  const lastHoverPointRef = useRef<THREE.Vector3 | null>(null);

  // Ignore stale hover state the instant the tool changes away from
  // Turnaround, rather than clearing it via an effect — derived-at-render
  // beats a synchronized setState for a value this cheap to recompute.
  const effectiveHover = tool === "turnaround" ? turnaroundHover : null;

  // Stable identity matters: EdgeGroup is memoized, and a new function every render would defeat that for every road.
  const handleTurnaroundHover = useCallback((edgeId: string | null, point: THREE.Vector3 | null) => {
    if (!edgeId || !point) {
      setTurnaroundHover(null);
      lastHoverPointRef.current = null;
      return;
    }
    const last = lastHoverPointRef.current;
    if (last && last.distanceTo(point) < 15) return;
    lastHoverPointRef.current = point;
    setTurnaroundHover({ edgeId, point });
  }, []);

  const turnaroundPlan = useMemo(
    () => (effectiveHover ? planTexasTurnaround(network, effectiveHover.edgeId, effectiveHover.point) : null),
    [network, effectiveHover]
  );

  const contractsByEdgeId = useMemo(() => {
    const map = new Map<string, ContractStatus>();
    for (const c of contracts ?? []) map.set(c.edgeId, c);
    return map;
  }, [contracts]);

  const speedRatioByEdgeId = useMemo(() => {
    const map = new Map<string, number>();
    for (const [edgeId, ratio] of edgeSpeedRatios ?? []) map.set(edgeId, ratio);
    return map;
  }, [edgeSpeedRatios]);

  const problemEdgeIdSet = useMemo(() => new Set(problemEdgeIds ?? []), [problemEdgeIds]);

  const clearanceViolations = useMemo(() => findClearanceViolations(network), [network]);

  const ringNodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of network.edges) {
      if (e.isRoundaboutRing) {
        set.add(e.fromNodeId);
        set.add(e.toNodeId);
      }
    }
    return set;
  }, [network]);

  const badgeIndexByEdgeId = useMemo(() => {
    const map = new Map<string, number>();
    let colorIdx = 0;
    for (const edge of network.edges) {
      if (edge.zone) map.set(edge.id, colorIdx++);
    }
    return map;
  }, [network]);

  const typeIndexByEdgeId = useMemo(() => {
    const map = new Map<string, number>();
    let entryIdx = 0;
    let destIdx = 0;
    for (const edge of network.edges) {
      if (edge.zone?.type === "entry") map.set(edge.id, entryIdx++);
      else if (edge.zone?.type === "destination") map.set(edge.id, destIdx++);
    }
    return map;
  }, [network]);

  // A two-way pair is two edges running opposite directions between the
  // same two nodes — used to decide which edges get a painted centerline
  // instead of treating each direction as an isolated one-way ribbon.
  const twoWayEdgeIdSet = useMemo(() => {
    const forwardKeys = new Set(network.edges.map((e) => `${e.fromNodeId}→${e.toNodeId}`));
    const set = new Set<string>();
    for (const e of network.edges) {
      if (forwardKeys.has(`${e.toNodeId}→${e.fromNodeId}`)) set.add(e.id);
    }
    return set;
  }, [network]);

  // Real junctions (2+ distinct connected neighbors) get a stop bar painted
  // near their approach; signalized junctions also get a crosswalk.
  const { stopBarEdgeIdSet, crosswalkEdgeIdSet } = useMemo(() => {
    const neighborsByNode = new Map<string, Set<string>>();
    for (const e of network.edges) {
      if (!neighborsByNode.has(e.fromNodeId)) neighborsByNode.set(e.fromNodeId, new Set());
      if (!neighborsByNode.has(e.toNodeId)) neighborsByNode.set(e.toNodeId, new Set());
      neighborsByNode.get(e.fromNodeId)!.add(e.toNodeId);
      neighborsByNode.get(e.toNodeId)!.add(e.fromNodeId);
    }
    const stopBars = new Set<string>();
    const crosswalks = new Set<string>();
    for (const e of network.edges) {
      if (e.isRoundaboutRing || e.isTexasTurnaround) continue;
      const destNode = network.nodesById.get(e.toNodeId);
      // A stop bar belongs at a real intersection: three or more roads meeting, and not at a freeway merge, a ramp
      // tapering into another road, or a simple joint where a road just carries on.
      const isIntersection = (neighborsByNode.get(e.toNodeId)?.size ?? 0) >= 3;
      if (!destNode || !isIntersection || e.taperEndFt > 0 || ringNodeIds.has(e.toNodeId)) continue;
      const signal = destNode.control?.type === "signal";
      if (e.isFreeway && !signal) continue;
      stopBars.add(e.id);
      if (signal) crosswalks.add(e.id);
    }
    return { stopBarEdgeIdSet: stopBars, crosswalkEdgeIdSet: crosswalks };
  }, [network, ringNodeIds]);

  const showHeatmap = heatmapEnabled && mode === "simulate";

  // Roads present at load (autosave, share link) just appear; only roads that arrive after this settles animate in.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 1800);
    return () => clearTimeout(id);
  }, []);

  return (
    <group>
      {!decorative &&
        network.edges
          .filter((edge) => edge.zone && badgeIndexByEdgeId.get(edge.id) !== undefined)
          .map((edge) => (
            <ZoneBadge
              key={`zone-${edge.id}`}
              edge={edge}
              badgeIndex={badgeIndexByEdgeId.get(edge.id)!}
              typeIndex={typeIndexByEdgeId.get(edge.id)!}
              contract={contractsByEdgeId.get(edge.id)}
              compact={hideClearanceWarnings}
              hidden={photo}
            />
          ))}
      {network.edges.map((edge) => (
        <EdgeGroup
          key={edge.id}
          edge={edge}
          badgeIndex={badgeIndexByEdgeId.get(edge.id)}
          typeIndex={typeIndexByEdgeId.get(edge.id)}
          // Only the heatmap reads this, so don't feed live speeds to every road while it's off — and round them,
          // so a road re-renders when its color band changes rather than on every 200 ms sample.
          speedRatio={showHeatmap ? quantizeRatio(speedRatioByEdgeId.get(edge.id)) : undefined}
          turnaroundHighlight={
            tool === "turnaround" &&
            (edge.id === effectiveHover?.edgeId || edge.id === turnaroundPlan?.targetEdgeId)
          }
          onTurnaroundHover={handleTurnaroundHover}
          isTwoWay={twoWayEdgeIdSet.has(edge.id)}
          hasStopBar={stopBarEdgeIdSet.has(edge.id)}
          hasCrosswalk={crosswalkEdgeIdSet.has(edge.id)}
          decorative={decorative}
          animateIn={armed && !decorative}
        />
      ))}

      {turnaroundPlan && <TurnaroundPreview plan={turnaroundPlan} />}

      {network.edges
        .filter((edge) => !edge.isRoundaboutRing && ringNodeIds.has(edge.toNodeId))
        .map((edge) => (
          <YieldMarker key={`yield-${edge.id}`} edge={edge} />
        ))}

      {mode === "simulate" &&
        network.edges
          .filter((edge) => problemEdgeIdSet.has(edge.id))
          .map((edge) => (
            <ProblemMarker key={`problem-${edge.id}`} edge={edge} />
          ))}

      {mode === "simulate" &&
        (incidentMarkers ?? []).map((position, i) => (
          <GridlockMarker key={`incident-${i}`} position={position} />
        ))}

      {mode === "simulate" &&
        (gridlockMarkers ?? []).map((position, i) => (
          <GridlockMarker key={`gridlock-${i}`} position={position} />
        ))}

      {mode === "simulate" &&
        nodes.map((node) => <NodeInspectTarget key={`inspect-node-${node.id}`} node={node} />)}

      {!hideClearanceWarnings &&
        clearanceViolations.map((violation, i) => (
        <ClearanceWarningMarker key={`clearance-${violation.edgeAId}-${violation.edgeBId}-${i}`} violation={violation} />
      ))}
    </group>
  );
}
