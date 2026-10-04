"use client";

import { memo, useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { getDetailShed } from "@/lib/perfDetail";
import { setConcreteRoad, setHonkChorus, setJakeBrake, setRoadRoar, stopRoadSounds } from "@/lib/sound";

/** Vehicles closer than this to the listener (ft) add to the tyre roar. */
const ROAR_RADIUS_FT = 650;
/** Roughly how many nearby vehicles make the roar as loud as it gets. */
const ROAR_SATURATION = 5;
/** Angry horns can be heard this far (ft). */
const HONK_RADIUS_FT = 1100;
/** A heavy truck's engine brake can be heard this far (ft). */
const JAKE_RADIUS_FT = 900;

/**
 * Drives the road sounds from what is near the player: tyre roar from the cars close to the camera (louder and brighter
 * on wet asphalt), and the engine-brake rumble of semis slowing down a grade. The listener is the chase camera when
 * riding along, otherwise the point the camera orbits. Renders nothing.
 */
function SoundscapeDriver({ snapshotRef, wet, running, texas, avgMph, rageMarkers, rageCount }: { snapshotRef: RefObject<VehicleSnapshot | null>; wet: boolean; running: boolean; texas: boolean; avgMph: number; rageMarkers: [number, number, number][]; rageCount: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const frame = useRef(0);

  useEffect(() => () => stopRoadSounds(), []);

  useFrame(() => {
    // The scan walks every vehicle, so it runs a few times a second rather than every rendered frame.
    frame.current = (frame.current + 1) % (getDetailShed() >= 1 ? 12 : 6);
    if (frame.current !== 0) return;
    const snapshot = snapshotRef.current;
    if (!running || !snapshot) {
      setRoadRoar(0, wet);
      setJakeBrake(0);
      setHonkChorus(0);
      return;
    }
    setConcreteRoad(texas, avgMph);
    const rideAlong = useEditorStore.getState().rideAlongActive;
    const lx = rideAlong || !controls ? camera.position.x : controls.target.x;
    const lz = rideAlong || !controls ? camera.position.z : controls.target.z;

    const m = snapshot.matrices;
    let roar = 0;
    for (let i = 0; i < snapshot.activeCount; i++) {
      const d = Math.hypot(m[i * 16 + 12] - lx, m[i * 16 + 14] - lz);
      if (d < ROAR_RADIUS_FT) roar += (1 - d / ROAR_RADIUS_FT) ** 2;
    }
    setRoadRoar(roar / ROAR_SATURATION, wet);

    let jake = 0;
    for (const p of snapshot.jakeBrakes) {
      const d = Math.hypot(p[0] - lx, p[2] - lz);
      jake = Math.max(jake, (1 - Math.min(1, d / JAKE_RADIUS_FT)) ** 2);
    }
    setJakeBrake(jake);

    // Fuming drivers: the closer the nearest, and the more of them, the busier the horns.
    let nearest = Infinity;
    for (const p of rageMarkers) nearest = Math.min(nearest, Math.hypot(p[0] - lx, p[2] - lz));
    const closeness = (1 - Math.min(1, nearest / HONK_RADIUS_FT)) ** 2;
    setHonkChorus(closeness * Math.min(1, 0.35 + rageCount / 25));
  });

  return null;
}

export default memo(SoundscapeDriver);
