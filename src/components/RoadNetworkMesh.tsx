"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { buildNetwork } from "@/sim/network";
import type { Edge3D } from "@/sim/types";
import {
  buildAsphaltRibbon,
  buildDashedStripe,
  buildJerseyBarrier,
  buildSolidStripe,
  computePierDescriptors,
  type PierDescriptor,
} from "./roadGeometry";

const ASPHALT_COLOR = "#2a2a2e";
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
}

function buildEdgeGeometries(edge: Edge3D): EdgeGeometries {
  const pavedHalfWidth = (edge.lanes * edge.laneWidthFt) / 2;
  const ribbon = buildAsphaltRibbon(edge, SHOULDER_FT);

  const stripes: StripeSpec[] = [];

  // Outer solid white edge lines.
  stripes.push({ geometry: buildSolidStripe(edge, -pavedHalfWidth, 0.5), color: WHITE_COLOR });
  stripes.push({ geometry: buildSolidStripe(edge, pavedHalfWidth, 0.5), color: WHITE_COLOR });

  // Dashed white lane separators between same-direction lanes.
  for (let k = 1; k < edge.lanes; k++) {
    const offset = (k - edge.lanes / 2) * edge.laneWidthFt;
    stripes.push({ geometry: buildDashedStripe(edge, offset), color: WHITE_COLOR });
  }

  // Solid double-yellow median treatment on the freeway proper (left shoulder side).
  const isFreeway = edge.kind === "mainline" || edge.kind === "overpass";
  if (isFreeway) {
    stripes.push({
      geometry: buildSolidStripe(edge, -(pavedHalfWidth + 1.0), 0.4),
      color: YELLOW_COLOR,
    });
    stripes.push({
      geometry: buildSolidStripe(edge, -(pavedHalfWidth + 1.7), 0.4),
      color: YELLOW_COLOR,
    });
  }

  const barriers: THREE.BufferGeometry[] = [];
  if (isFreeway) {
    const barrierOffset = pavedHalfWidth + SHOULDER_FT - 0.5;
    barriers.push(buildJerseyBarrier(edge, -barrierOffset));
    barriers.push(buildJerseyBarrier(edge, barrierOffset));
  }

  const piers = computePierDescriptors(edge);

  return { ribbon, stripes, barriers, piers };
}

function EdgeGroup({ edge }: { edge: Edge3D }) {
  const geometries = useMemo(() => buildEdgeGeometries(edge), [edge]);

  return (
    <group>
      <mesh geometry={geometries.ribbon} receiveShadow>
        <meshStandardMaterial color={ASPHALT_COLOR} roughness={0.95} metalness={0.05} />
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
          <group
            key={i}
            position={pier.capPosition}
            rotation={[0, pier.rotationY, 0]}
          >
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
              >
                <cylinderGeometry args={[1.3, 1.4, columnTopY, 16]} />
                <meshStandardMaterial color={PIER_COLOR} roughness={0.92} />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}

export default function RoadNetworkMesh() {
  const network = useMemo(() => buildNetwork(), []);

  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[100, -0.15, 250]}
        receiveShadow
      >
        <planeGeometry args={[9000, 4200]} />
        <meshStandardMaterial color="#1c1c20" roughness={1} metalness={0} />
      </mesh>

      {network.edges.map((edge) => (
        <EdgeGroup key={edge.id} edge={edge} />
      ))}
    </group>
  );
}
