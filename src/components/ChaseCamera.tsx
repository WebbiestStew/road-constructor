"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";

interface ChaseCameraProps {
  snapshotRef: RefObject<VehicleSnapshot | null>;
}

/** How far behind and above the tracked vehicle the camera trails, in feet. */
const FOLLOW_BACK_FT = 34;
const FOLLOW_UP_FT = 14;
/** How far ahead of the vehicle the camera looks, in feet — keeps the view pointed down the road rather than at the vehicle's own roof. */
const LOOK_AHEAD_FT = 40;
/** Exponential ease-in rates (per second) for the chase position/look-at target — higher settles faster, lower trails more cinematically. */
const POSITION_DAMPING = 4.5;
const LOOKAT_DAMPING = 6;

const ORIGIN = new THREE.Vector3(0, 0, 0);
const _vehiclePos = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _desiredLookAt = new THREE.Vector3();

/** Reads one vehicle instance's world position and forward direction straight out of its column-major instance matrix (translation at [12,13,14], the rotated local +Z / forward axis at [8,9,10] — the same convention the sim worker composes vehicle matrices with). */
function readVehicle(matrices: Float32Array, slot: number, outPos: THREE.Vector3, outForward: THREE.Vector3) {
  const base = slot * 16;
  outPos.set(matrices[base + 12], matrices[base + 13], matrices[base + 14]);
  outForward.set(matrices[base + 8], matrices[base + 9], matrices[base + 10]).normalize();
}

/**
 * Third-person "ride along" camera: locks onto one live vehicle instance
 * slot and chases it from behind, re-locking onto the nearest active
 * vehicle whenever the tracked slot empties out (that vehicle finished its
 * trip or was despawned). Swaps in as the scene's default camera only while
 * `rideAlongActive` is set — the parent is responsible for not rendering
 * OrbitControls at the same time, since this camera drives its own pose
 * every frame. No visual output beyond the camera itself.
 */
export default function ChaseCamera({ snapshotRef }: ChaseCameraProps) {
  const active = useEditorStore((s) => s.rideAlongActive);
  const camera = useThree((s) => s.camera);
  const trackedSlotRef = useRef<number | null>(null);
  const lookAtRef = useRef(new THREE.Vector3());
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!active) {
      trackedSlotRef.current = null;
      initializedRef.current = false;
    }
  }, [active]);

  useFrame((_state, delta) => {
    if (!active) return;
    const snapshot = snapshotRef.current;
    if (!snapshot || snapshot.activeCount === 0) return;

    let slot = trackedSlotRef.current;
    if (slot === null || slot >= snapshot.activeCount) {
      // Lock onto whichever active vehicle is nearest a reference point: the
      // world origin on first activation (roughly where the default overview
      // camera looks), or wherever the camera currently sits after that —
      // so a re-lock (following a completed/despawned trip) grabs a nearby
      // car instead of yanking the view across the whole map.
      const referencePoint = initializedRef.current ? camera.position : ORIGIN;
      let bestSlot = 0;
      let bestDistSq = Infinity;
      for (let i = 0; i < snapshot.activeCount; i++) {
        const base = i * 16;
        const dx = snapshot.matrices[base + 12] - referencePoint.x;
        const dz = snapshot.matrices[base + 14] - referencePoint.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestSlot = i;
        }
      }
      slot = bestSlot;
      trackedSlotRef.current = slot;
    }

    readVehicle(snapshot.matrices, slot, _vehiclePos, _forward);

    _desiredPos.copy(_vehiclePos).addScaledVector(_forward, -FOLLOW_BACK_FT);
    _desiredPos.y = _vehiclePos.y + FOLLOW_UP_FT;
    _desiredLookAt.copy(_vehiclePos).addScaledVector(_forward, LOOK_AHEAD_FT);

    if (!initializedRef.current) {
      camera.position.copy(_desiredPos);
      lookAtRef.current.copy(_desiredLookAt);
      initializedRef.current = true;
    } else {
      camera.position.lerp(_desiredPos, 1 - Math.exp(-POSITION_DAMPING * delta));
      lookAtRef.current.lerp(_desiredLookAt, 1 - Math.exp(-LOOKAT_DAMPING * delta));
    }

    camera.lookAt(lookAtRef.current);
  });

  if (!active) return null;
  return (
    <PerspectiveCamera
      makeDefault
      fov={62}
      near={1}
      far={8000}
      position={[0, FOLLOW_UP_FT, -FOLLOW_BACK_FT]}
    />
  );
}
