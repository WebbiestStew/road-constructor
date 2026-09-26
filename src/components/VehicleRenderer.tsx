"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  MAX_VEHICLES,
  VEHICLE_HEIGHT_FT,
  VEHICLE_LENGTH_FT,
  VEHICLE_WIDTH_FT,
} from "@/sim/types";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";

interface VehicleRendererProps {
  snapshotRef: RefObject<VehicleSnapshot | null>;
}

/**
 * Renders up to MAX_VEHICLES vehicles via a single THREE.InstancedMesh.
 * Every worker tick hands us a fresh, fully-populated Float32Array pair
 * (transferable ArrayBuffers, already turned into typed-array views by the
 * hook). Rather than copying that data into a persistent buffer, we swap
 * the InstancedMesh's own attribute `.array` reference directly to the
 * incoming typed array each frame — a true zero-copy hand-off from worker
 * memory straight to the GPU upload, with no per-frame allocation on the
 * render thread.
 */
export default function VehicleRenderer({ snapshotRef }: VehicleRendererProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const lastVersionRef = useRef(0);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_VEHICLES * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    const snapshot = snapshotRef.current;
    if (!mesh || !snapshot || !mesh.instanceColor) return;
    if (snapshot.version === lastVersionRef.current) return;
    lastVersionRef.current = snapshot.version;

    mesh.instanceMatrix.array = snapshot.matrices;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.array = snapshot.colors;
    mesh.instanceColor.needsUpdate = true;
    mesh.count = snapshot.activeCount;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MAX_VEHICLES]}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[VEHICLE_WIDTH_FT, VEHICLE_HEIGHT_FT, VEHICLE_LENGTH_FT]} />
      <meshStandardMaterial color="#ffffff" roughness={0.45} metalness={0.35} />
    </instancedMesh>
  );
}
