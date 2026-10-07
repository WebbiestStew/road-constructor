"use client";

import { useEffect, useRef, type RefObject, memo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { VEHICLE_KIND_CODE, type VehicleKind } from "@/sim/types";

interface ChaseCameraProps {
  snapshotRef: RefObject<VehicleSnapshot | null>;
}

/** How far behind and above the tracked vehicle the camera trails, in feet. */
const FOLLOW_BACK_FT = 34;
const FOLLOW_UP_FT = 14;
/** How far ahead of the vehicle the camera looks, in feet — keeps the view pointed down the road rather than at the vehicle's own roof. */
const LOOK_AHEAD_FT = 40;
/** The driver's-seat view: eye height above the vehicle's centre, how far forward of it, and how far down the road it looks. */
const HOOD_UP_FT = 4.1;
const HOOD_FORWARD_FT = 3.5;
const HOOD_LOOK_AHEAD_FT = 120;
/** Exponential ease-in rates (per second) for the chase position/look-at target — higher settles faster, lower trails more cinematically. */
const POSITION_DAMPING = 4.5;
const LOOKAT_DAMPING = 6;
const HOOD_DAMPING = 18;

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

/** The slot a vehicle id sits in this tick (the sim writes each vehicle's id into slot 11 of its matrix), or -1. Slots reorder as vehicles come and go, so the camera follows the id, not the slot. */
function slotOfId(matrices: Float32Array, count: number, id: number): number {
  for (let i = 0; i < count; i++) if (matrices[i * 16 + 11] === id) return i;
  return -1;
}

const KIND_BY_CODE = new Map<number, VehicleKind>((Object.entries(VEHICLE_KIND_CODE) as [VehicleKind, number][]).map(([k, c]) => [c, k]));

/** The id of the next (or previous) vehicle after `fromId`, in id order, that passes the filter; null if none does. */
function pickVehicle(matrices: Float32Array, count: number, fromId: number | null, dir: 1 | -1, filter: VehicleKind | "any"): number | null {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const kind = KIND_BY_CODE.get(matrices[i * 16 + 3]);
    if (filter === "any" ? kind === "debris" : kind !== filter) continue;
    ids.push(matrices[i * 16 + 11]);
  }
  if (ids.length === 0) return null;
  ids.sort((a, b) => a - b);
  if (fromId === null) return ids[0];
  if (dir === 1) return ids.find((id) => id > fromId) ?? ids[0];
  for (let i = ids.length - 1; i >= 0; i--) if (ids[i] < fromId) return ids[i];
  return ids[ids.length - 1];
}

/**
 * Third-person "ride along" camera: locks onto one live vehicle and chases it from behind (or, while the player is
 * driving, from the driver's seat if they chose that view), re-locking onto the nearest active vehicle whenever the
 * tracked one is gone (it finished its trip or was despawned). Swaps in as the scene's default camera only while
 * `rideAlongActive` is set — the parent is responsible for not rendering OrbitControls at the same time, since this
 * camera drives its own pose every frame. No visual output beyond the camera itself.
 */
function ChaseCamera({ snapshotRef }: ChaseCameraProps) {
  const active = useEditorStore((s) => s.rideAlongActive);
  const camera = useThree((s) => s.camera);
  const trackedIdRef = useRef<number | null>(null);
  const lookAtRef = useRef(new THREE.Vector3());
  const initializedRef = useRef(false);
  const lastCamRef = useRef<"chase" | "hood">("chase");
  const lastStepRef = useRef(0);

  useEffect(() => {
    if (!active) {
      trackedIdRef.current = null;
      initializedRef.current = false;
    }
  }, [active]);

  useFrame((_state, delta) => {
    if (!active) return;
    const snapshot = snapshotRef.current;
    if (!snapshot || snapshot.activeCount === 0) return;
    const store = useEditorStore.getState();

    // The car being driven is always the one to follow.
    if (store.drivingId !== null) trackedIdRef.current = store.drivingId;
    // The player asked for another vehicle.
    if (store.rideAlongStep.n !== lastStepRef.current) {
      lastStepRef.current = store.rideAlongStep.n;
      if (store.drivingId === null) {
        const next = pickVehicle(snapshot.matrices, snapshot.activeCount, trackedIdRef.current, store.rideAlongStep.dir, store.rideAlongFilter);
        if (next !== null) {
          trackedIdRef.current = next;
          initializedRef.current = false;
        }
      }
    }

    let slot = trackedIdRef.current !== null ? slotOfId(snapshot.matrices, snapshot.activeCount, trackedIdRef.current) : -1;
    if (slot < 0) {
      // Lock onto whichever active vehicle is nearest a reference point: the world origin on first activation (roughly
      // where the default overview camera looks), or wherever the camera currently sits after that — so a re-lock
      // (following a completed/despawned trip) grabs a nearby car instead of yanking the view across the whole map.
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
      trackedIdRef.current = snapshot.matrices[slot * 16 + 11];
    }
    const kind = KIND_BY_CODE.get(snapshot.matrices[slot * 16 + 3]) ?? null;
    if (store.rideAlongVehicleId !== trackedIdRef.current || store.rideAlongVehicleKind !== kind) useEditorStore.setState({ rideAlongVehicleId: trackedIdRef.current, rideAlongVehicleKind: kind });

    readVehicle(snapshot.matrices, slot, _vehiclePos, _forward);

    const hood = store.drivingId !== null && store.driveCam === "hood";
    if (hood !== (lastCamRef.current === "hood")) {
      initializedRef.current = false; // snap to the new view instead of sliding there
      lastCamRef.current = hood ? "hood" : "chase";
    }
    if (hood) {
      _desiredPos.copy(_vehiclePos).addScaledVector(_forward, HOOD_FORWARD_FT);
      _desiredPos.y = _vehiclePos.y + HOOD_UP_FT;
      _desiredLookAt.copy(_vehiclePos).addScaledVector(_forward, HOOD_LOOK_AHEAD_FT);
      _desiredLookAt.y = _vehiclePos.y + HOOD_UP_FT - 1;
    } else {
      _desiredPos.copy(_vehiclePos).addScaledVector(_forward, -FOLLOW_BACK_FT);
      _desiredPos.y = _vehiclePos.y + FOLLOW_UP_FT;
      _desiredLookAt.copy(_vehiclePos).addScaledVector(_forward, LOOK_AHEAD_FT);
    }

    if (!initializedRef.current) {
      camera.position.copy(_desiredPos);
      lookAtRef.current.copy(_desiredLookAt);
      initializedRef.current = true;
    } else if (hood) {
      camera.position.lerp(_desiredPos, 1 - Math.exp(-HOOD_DAMPING * delta));
      lookAtRef.current.lerp(_desiredLookAt, 1 - Math.exp(-HOOD_DAMPING * 0.6 * delta));
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

/** Memoized: the game page re-renders several times a second with live traffic stats, and none of this scene depends on them. */
export default memo(ChaseCamera);
