"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { assembleNetwork } from "@/sim/network";
import { useEditorStore } from "@/state/editorStore";
import type { ContractStatus, Edge3D, EdgeSpeedRatio } from "@/sim/types";
import { badgeColorForIndex } from "./hud/badgeColors";
import { IconWarning } from "./hud/icons";
import {
  buildAsphaltRibbon,
  buildDashedStripe,
  buildJerseyBarrier,
  buildLaneArrows,
  buildSolidStripe,
  computePierDescriptors,
  type PierDescriptor,
} from "./roadGeometry";

const ASPHALT_COLOR = "#3a4155";
const ASPHALT_SELECTED_COLOR = "#4a6a8f";
const ROUNDABOUT_COLOR = "#434b60";
const ROUNDABOUT_SELECTED_COLOR = "#4e6f92";
const WHITE_COLOR = "#f4f4f5";
const YELLOW_COLOR = "#eab308";
const BARRIER_COLOR = "#9a9aa0";
const PIER_COLOR = "#75757c";
const SHOULDER_FT = 4;

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

interface EdgeGeometries {
  ribbon: THREE.BufferGeometry;
  stripes: StripeSpec[];
  barriers: THREE.BufferGeometry[];
  piers: PierDescriptor[];
  startPoint: THREE.Vector3;
  endPoint: THREE.Vector3;
}

function buildEdgeGeometries(edge: Edge3D): EdgeGeometries {
  const pavedHalfWidth = (edge.lanes * edge.laneWidthFt) / 2;
  const ribbon = buildAsphaltRibbon(edge, SHOULDER_FT);

  const stripes: StripeSpec[] = [];
  stripes.push({ geometry: buildSolidStripe(edge, -pavedHalfWidth, 0.5), color: WHITE_COLOR });
  stripes.push({ geometry: buildSolidStripe(edge, pavedHalfWidth, 0.5), color: WHITE_COLOR });

  for (let k = 1; k < edge.lanes; k++) {
    const offset = (k - edge.lanes / 2) * edge.laneWidthFt;
    stripes.push({ geometry: buildDashedStripe(edge, offset), color: WHITE_COLOR });
  }

  if (edge.isFreeway) {
    stripes.push({ geometry: buildSolidStripe(edge, -(pavedHalfWidth + 1.0), 0.4), color: YELLOW_COLOR });
    stripes.push({ geometry: buildSolidStripe(edge, -(pavedHalfWidth + 1.7), 0.4), color: YELLOW_COLOR });
  }

  if (edge.length > 90) {
    for (let lane = 0; lane < edge.lanes; lane++) {
      const turnBias = edge.laneTurnBias[lane] ?? 0;
      stripes.push({ geometry: buildLaneArrows(edge, lane, 140, 16, 5, 0.04, turnBias), color: WHITE_COLOR });
    }
  }

  const barriers: THREE.BufferGeometry[] = [];
  if (edge.isFreeway) {
    const barrierOffset = pavedHalfWidth + SHOULDER_FT - 0.5;
    barriers.push(buildJerseyBarrier(edge, -barrierOffset));
    barriers.push(buildJerseyBarrier(edge, barrierOffset));
  }

  const piers = computePierDescriptors(edge);
  const startPoint = edge.spline.getPointAt(0);
  const endPoint = edge.spline.getPointAt(1);

  return { ribbon, stripes, barriers, piers, startPoint, endPoint };
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
}: {
  edge: Edge3D;
  contract?: ContractStatus;
  badgeIndex?: number;
  typeIndex?: number;
  speedRatio?: number;
}) {
  const geometries = useMemo(() => buildEdgeGeometries(edge), [edge]);
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

    if (store.tool === "delete") {
      store.deleteEdge(edge.id);
    } else if (store.tool === "inspect") {
      store.setSelection({ kind: "edge", id: edge.id });
    } else if (store.tool === "zone") {
      store.cycleEdgeZone(edge.id);
    } else if (store.tool === "draw") {
      const splitNodeId = store.splitEdgeAt(edge.id, point);
      if (store.drawFromNodeId) {
        store.drawTo(store.drawFromNodeId, splitNodeId, point);
      } else {
        store.startDrawChain(splitNodeId);
      }
    }
  };

  return (
    <group>
      <mesh geometry={geometries.ribbon} receiveShadow onClick={handleClick}>
        <meshStandardMaterial
          color={
            edge.isRoundaboutRing
              ? isSelected
                ? ROUNDABOUT_SELECTED_COLOR
                : ROUNDABOUT_COLOR
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

      {geometries.barriers.map((geo, i) => (
        <mesh key={i} geometry={geo} castShadow receiveShadow>
          <meshStandardMaterial color={BARRIER_COLOR} roughness={0.85} side={THREE.DoubleSide} />
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
              <mesh key={ci} castShadow receiveShadow position={[offset, -(columnTopY / 2 + 1), 0]}>
                <cylinderGeometry args={[1.3, 1.4, columnTopY, 16]} />
                <meshStandardMaterial color={PIER_COLOR} roughness={0.92} />
              </mesh>
            ))}
          </group>
        );
      })}

      {edge.zone && badgeIndex !== undefined && typeIndex !== undefined && (
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
}: {
  contracts?: ContractStatus[];
  edgeSpeedRatios?: EdgeSpeedRatio[];
  problemEdgeIds?: string[];
  gridlockMarkers?: [number, number, number][];
}) {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const mode = useEditorStore((s) => s.mode);

  const network = useMemo(() => assembleNetwork({ nodes, edges }), [nodes, edges]);

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
        />
      ))}

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
    </group>
  );
}
