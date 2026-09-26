"use client";

import { useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { assembleNetwork } from "@/sim/network";
import { useEditorStore } from "@/state/editorStore";
import type { ContractStatus, Edge3D } from "@/sim/types";
import {
  buildAsphaltRibbon,
  buildDashedStripe,
  buildJerseyBarrier,
  buildSolidStripe,
  computePierDescriptors,
  type PierDescriptor,
} from "./roadGeometry";

const ASPHALT_COLOR = "#2a2a2e";
const ASPHALT_SELECTED_COLOR = "#3a4a5e";
const ROUNDABOUT_COLOR = "#33383f";
const ROUNDABOUT_SELECTED_COLOR = "#3d4a5e";
const WHITE_COLOR = "#f4f4f5";
const YELLOW_COLOR = "#eab308";
const BARRIER_COLOR = "#8d8d93";
const PIER_COLOR = "#6b6b70";
const SHOULDER_FT = 4;

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

function ZoneMarker({ edge }: { edge: Edge3D; contract?: ContractStatus }) {
  if (!edge.zone) return null;

  if (edge.zone.type === "entry") {
    const p = edge.spline.getPointAt(0);
    return (
      <mesh position={[p.x, p.y + 14, p.z]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[5, 12, 6]} />
        <meshStandardMaterial color="#22c55e" emissive="#22c55e" emissiveIntensity={0.4} />
      </mesh>
    );
  }

  return null;
}

function DestinationMarker({ edge, contract }: { edge: Edge3D; contract?: ContractStatus }) {
  if (edge.zone?.type !== "destination") return null;
  const p = edge.spline.getPointAt(1);
  const color = !contract || contract.sampleCount === 0 ? "#9ca3af" : contract.meetsThreshold ? "#22c55e" : "#ef4444";
  return (
    <group position={[p.x, p.y, p.z]}>
      <mesh position={[0, 8, 0]}>
        <cylinderGeometry args={[0.6, 0.6, 16, 8]} />
        <meshStandardMaterial color="#3f3f46" />
      </mesh>
      <mesh position={[0, 18, 0]}>
        <coneGeometry args={[5, 10, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} />
      </mesh>
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

function EdgeGroup({ edge, contract }: { edge: Edge3D; contract?: ContractStatus }) {
  const geometries = useMemo(() => buildEdgeGeometries(edge), [edge]);
  const isSelected = useEditorStore(
    (s) => s.selection?.kind === "edge" && s.selection.id === edge.id
  );

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

      <ZoneMarker edge={edge} contract={contract} />
      <DestinationMarker edge={edge} contract={contract} />
    </group>
  );
}

export default function RoadNetworkMesh({ contracts }: { contracts?: ContractStatus[] }) {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);

  const network = useMemo(() => assembleNetwork({ nodes, edges }), [nodes, edges]);

  const contractsByEdgeId = useMemo(() => {
    const map = new Map<string, ContractStatus>();
    for (const c of contracts ?? []) map.set(c.edgeId, c);
    return map;
  }, [contracts]);

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

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.15, 0]} receiveShadow>
        <planeGeometry args={[30000, 30000]} />
        <meshStandardMaterial color="#1c1c20" roughness={1} metalness={0} />
      </mesh>

      {network.edges.map((edge) => (
        <EdgeGroup key={edge.id} edge={edge} contract={contractsByEdgeId.get(edge.id)} />
      ))}

      {network.edges
        .filter((edge) => !edge.isRoundaboutRing && ringNodeIds.has(edge.toNodeId))
        .map((edge) => (
          <YieldMarker key={`yield-${edge.id}`} edge={edge} />
        ))}
    </group>
  );
}
