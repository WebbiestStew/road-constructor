"use client";

import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Html, Line } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { assembleNetwork, assembleNetworkCached, planTexasTurnaround, type TexasTurnaroundPlan } from "@/sim/network";
import { findClearanceViolations, MIN_BRIDGE_CLEARANCE_FT, type ClearanceViolation } from "@/sim/clearance";
import { ROAD_CLASSES } from "@/sim/roadClasses";
import { useEditorStore } from "@/state/editorStore";
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
  buildTaperedPierColumn,
  computePierDescriptors,
  type PierDescriptor,
} from "./roadGeometry";

const ASPHALT_COLOR = "#3a4155";
const ASPHALT_SELECTED_COLOR = "#4a6a8f";
const ROUNDABOUT_COLOR = "#434b60";
const ROUNDABOUT_SELECTED_COLOR = "#4e6f92";
const TEXAS_TURNAROUND_COLOR = "#8a4a2f";
const TEXAS_TURNAROUND_SELECTED_COLOR = "#a85a3a";
const WHITE_COLOR = "#f4f4f5";
const YELLOW_COLOR = "#eab308";
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
/** Wider painted buffer (ft) for divided-class centerlines, reading as a neutral median rather than a plain double-yellow. */
const DIVIDED_CENTERLINE_GAP_FT = 1.6;
/** A lane-boundary offset this close to 0 is treated as landing on the centerline itself, so it's painted yellow (below) instead of getting a redundant white dash. */
const CENTERLINE_EPSILON_FT = 0.05;

/**
 * The terrain is a solid plane, so a cutting or tunnel would simply vanish beneath it (leaving only a few
 * barrier rails poking through). This lays a ground-level strip over just the underground stretch — the real
 * ribbon still runs below it — so the player can see where the road dives and where it surfaces.
 */
function buildBelowGradeOverlay(edge: Edge3D): THREE.BufferGeometry | null {
  let minY = Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i <= 24; i++) {
    edge.spline.getPointAt(i / 24, p);
    minY = Math.min(minY, p.y);
  }
  // Spline smoothing can dip a foot or two below zero at the base of a ramp; only a real cutting or tunnel gets an overlay.
  if (minY > -4) return null;
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

  const stripes: StripeSpec[] = [];
  stripes.push({ geometry: buildSolidStripe(edge, -pavedHalfWidth, 0.5), color: WHITE_COLOR });
  stripes.push({ geometry: buildSolidStripe(edge, pavedHalfWidth, 0.5), color: WHITE_COLOR });

  for (let k = 1; k < edge.lanes; k++) {
    const offset = (k - edge.lanes / 2) * edge.laneWidthFt;
    // The boundary between a direction's own lanes can land exactly on the
    // shared two-way centerline (offset 0) purely as an artifact of the
    // symmetric lane-offset formula — paint that one yellow below instead of
    // stacking a redundant white dash on top of it.
    if (isCenterlineEdge && Math.abs(offset) < CENTERLINE_EPSILON_FT) continue;
    stripes.push({ geometry: buildDashedStripe(edge, offset), color: WHITE_COLOR });
  }

  if (isCenterlineEdge) {
    const gap = roadClass.divided ? DIVIDED_CENTERLINE_GAP_FT : CENTERLINE_GAP_FT;
    stripes.push({ geometry: buildSolidStripe(edge, -gap, 0.35), color: YELLOW_COLOR });
    stripes.push({ geometry: buildSolidStripe(edge, gap, 0.35), color: YELLOW_COLOR });
  }

  if (edge.isFreeway) {
    stripes.push({ geometry: buildSolidStripe(edge, -(pavedHalfWidth + 1.0), 0.4), color: YELLOW_COLOR });
    stripes.push({ geometry: buildSolidStripe(edge, -(pavedHalfWidth + 1.7), 0.4), color: YELLOW_COLOR });
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
  if (edge.isFreeway) {
    // Freeways keep the heavier F-shape Jersey barrier at grade or elevated.
    const barrierOffset = pavedHalfWidth + SHOULDER_FT - 0.5;
    barriers.push(buildJerseyBarrier(edge, -barrierOffset));
    barriers.push(buildJerseyBarrier(edge, barrierOffset));
  } else if (edge.isElevated && !edge.isRoundaboutRing) {
    // A raised non-freeway road (a Tier-1+ street/avenue) still has a real
    // fall hazard along its exposed edge — give it a plainer concrete
    // parapet rail instead of leaving the drop-off unguarded.
    const parapetOffset = pavedHalfWidth + 0.5;
    parapets.push(buildParapet(edge, -parapetOffset));
    parapets.push(buildParapet(edge, parapetOffset));
  }

  const markingMeshes: THREE.BufferGeometry[] = [];
  const canMarkJunction = !edge.isRoundaboutRing && edge.length > 25;
  if (canMarkJunction && hasStopBar) markingMeshes.push(buildStopBar(edge));
  if (canMarkJunction && hasCrosswalk) markingMeshes.push(...buildCrosswalkBars(edge));

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
    if (startPoint.y > 2) {
      // no abutment: this end continues from an already-elevated point
      // (an interior joint of a longer elevated corridor — a pier belongs
      // there, not a ground transition wall)
    } else {
      const tangent = edge.spline.getTangentAt(0);
      const heightFt = Math.max(DECK_THICKNESS_FT + 1, edge.spline.getPointAt(0.02).y);
      abutments.push({
        position: [startPoint.x, heightFt / 2, startPoint.z],
        rotationY: Math.atan2(tangent.x, tangent.z),
        halfWidth: abutmentHalfWidth,
        heightFt,
      });
    }
    if (endPoint.y <= 2) {
      const tangent = edge.spline.getTangentAt(1);
      const heightFt = Math.max(DECK_THICKNESS_FT + 1, edge.spline.getPointAt(0.98).y);
      abutments.push({
        position: [endPoint.x, heightFt / 2, endPoint.z],
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

function ZoneBadge({
  edge,
  badgeIndex,
  typeIndex,
  contract,
}: {
  edge: Edge3D;
  badgeIndex: number;
  typeIndex: number;
  contract?: ContractStatus;
}) {
  if (!edge.zone) return null;
  const isEntry = edge.zone.type === "entry";
  const p = edge.spline.getPointAt(isEntry ? 0 : 1);
  const color = badgeColorForIndex(badgeIndex);
  const label = isEntry ? `Entry ${typeIndex + 1}` : `Dest ${typeIndex + 1}`;

  let statusColor: string | null = null;
  if (!isEntry) {
    statusColor = !contract || contract.sampleCount === 0 ? "#9ca3af" : contract.meetsThreshold ? "#3b82f6" : "#ef4444";
  }

  return (
    <Html position={[p.x, p.y, p.z]} style={{ pointerEvents: "none" }} zIndexRange={[10, 0]} occlude={false}>
      <div style={{ position: "relative", transform: "translate(-50%, -100%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div
          style={{
            background: color,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 9px",
            borderRadius: 7,
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
            border: "1.5px solid rgba(255,255,255,0.55)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {label}
        </div>
        <div style={{ width: 2, height: 24, background: color }} />
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
}

/** A pulsing "trouble here" marker over an edge that's been badly congested for a while — the game's "find the problem" signal, on by default (unlike the opt-in heatmap). */
function ProblemMarker({ edge }: { edge: Edge3D }) {
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
}

/** A pulsing red exclamation over a vehicle that's been near-stationary long enough to be flagged as gridlocked — it despawns for a throughput penalty shortly after this appears. */
function GridlockMarker({ position }: { position: [number, number, number] }) {
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
}

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
function NodeInspectTarget({ node }: { node: NodeSpec }) {
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
}

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

function YieldMarker({ edge }: { edge: Edge3D }) {
  const p = edge.spline.getPointAt(1);
  const tangent = edge.spline.getTangentAt(1);
  const rotationY = Math.atan2(tangent.x, tangent.z);
  return (
    <mesh position={[p.x, p.y + 0.1, p.z]} rotation={[-Math.PI / 2, 0, rotationY]}>
      <coneGeometry args={[3.2, 0.4, 3]} />
      <meshStandardMaterial color="#f4f4f5" emissive="#f4f4f5" emissiveIntensity={0.15} />
    </mesh>
  );
}

function EdgeGroup({
  edge,
  contract,
  badgeIndex,
  typeIndex,
  speedRatio,
  turnaroundHighlight,
  onTurnaroundHover,
  isTwoWay,
  hasStopBar,
  hasCrosswalk,
  decorative,
}: {
  decorative?: boolean;
  edge: Edge3D;
  contract?: ContractStatus;
  badgeIndex?: number;
  typeIndex?: number;
  speedRatio?: number;
  turnaroundHighlight?: boolean;
  onTurnaroundHover?: (edgeId: string | null, point: THREE.Vector3 | null) => void;
  isTwoWay: boolean;
  hasStopBar: boolean;
  hasCrosswalk: boolean;
}) {
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
    if (store.tool === "lanes" || store.tool === "speed") {
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
    <group>
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

      {!decorative && edge.zone && badgeIndex !== undefined && typeIndex !== undefined && (
        <ZoneBadge edge={edge} badgeIndex={badgeIndex} typeIndex={typeIndex} contract={contract} />
      )}
    </group>
  );
}

export default function RoadNetworkMesh({
  contracts,
  edgeSpeedRatios,
  problemEdgeIds,
  gridlockMarkers,
  networkOverride,
}: {
  /** Render this fixed network instead of the editor's (used by the landing page): no zone badges, not clickable. */
  networkOverride?: NetworkSnapshot;
  contracts?: ContractStatus[];
  edgeSpeedRatios?: EdgeSpeedRatio[];
  problemEdgeIds?: string[];
  gridlockMarkers?: [number, number, number][];
}) {
  const storeNodes = useEditorStore((s) => s.nodes);
  const storeEdges = useEditorStore((s) => s.edges);
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const nodes = networkOverride?.nodes ?? storeNodes;
  const edges = networkOverride?.edges ?? storeEdges;
  const decorative = networkOverride !== undefined;

  const network = useMemo(
    () => (decorative ? assembleNetwork({ nodes, edges }) : assembleNetworkCached(nodes, edges)),
    [nodes, edges, decorative]
  );

  const [turnaroundHover, setTurnaroundHover] = useState<{ edgeId: string; point: THREE.Vector3 } | null>(null);
  const lastHoverPointRef = useRef<THREE.Vector3 | null>(null);

  // Ignore stale hover state the instant the tool changes away from
  // Turnaround, rather than clearing it via an effect — derived-at-render
  // beats a synchronized setState for a value this cheap to recompute.
  const effectiveHover = tool === "turnaround" ? turnaroundHover : null;

  const handleTurnaroundHover = (edgeId: string | null, point: THREE.Vector3 | null) => {
    if (!edgeId || !point) {
      setTurnaroundHover(null);
      lastHoverPointRef.current = null;
      return;
    }
    const last = lastHoverPointRef.current;
    if (last && last.distanceTo(point) < 15) return;
    lastHoverPointRef.current = point;
    setTurnaroundHover({ edgeId, point });
  };

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
      const isJunction = (neighborsByNode.get(e.toNodeId)?.size ?? 0) >= 2;
      if (!destNode || !isJunction) continue;
      stopBars.add(e.id);
      if (destNode.control?.type === "signal") crosswalks.add(e.id);
    }
    return { stopBarEdgeIdSet: stopBars, crosswalkEdgeIdSet: crosswalks };
  }, [network]);

  return (
    <group>
      {network.edges.map((edge) => (
        <EdgeGroup
          key={edge.id}
          edge={edge}
          contract={contractsByEdgeId.get(edge.id)}
          badgeIndex={badgeIndexByEdgeId.get(edge.id)}
          typeIndex={typeIndexByEdgeId.get(edge.id)}
          speedRatio={speedRatioByEdgeId.get(edge.id)}
          turnaroundHighlight={
            tool === "turnaround" &&
            (edge.id === effectiveHover?.edgeId || edge.id === turnaroundPlan?.targetEdgeId)
          }
          onTurnaroundHover={handleTurnaroundHover}
          isTwoWay={twoWayEdgeIdSet.has(edge.id)}
          hasStopBar={stopBarEdgeIdSet.has(edge.id)}
          hasCrosswalk={crosswalkEdgeIdSet.has(edge.id)}
          decorative={decorative}
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
        (gridlockMarkers ?? []).map((position, i) => (
          <GridlockMarker key={`gridlock-${i}`} position={position} />
        ))}

      {mode === "simulate" &&
        nodes.map((node) => <NodeInspectTarget key={`inspect-node-${node.id}`} node={node} />)}

      {clearanceViolations.map((violation, i) => (
        <ClearanceWarningMarker key={`clearance-${violation.edgeAId}-${violation.edgeBId}-${i}`} violation={violation} />
      ))}
    </group>
  );
}
