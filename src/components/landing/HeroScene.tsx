"use client";

import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import RoadNetworkMesh from "@/components/RoadNetworkMesh";
import Terrain from "@/components/Terrain";
import VehicleRenderer from "@/components/VehicleRenderer";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { getDemoCity, getDemoRoadSegments } from "@/sim/demoCity";
import { useGlEpoch, useGraphics } from "@/lib/quality";
import FrameLimiter from "@/components/FrameLimiter";

const HAZE = "#ffd9e6";

/** Grows its children up out of the ground when `show` flips on — the "building it" moment. */
function Rise({ show, children }: { show: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const progress = useRef(0);

  useFrame((_, delta) => {
    const g = ref.current;
    if (!g) return;
    const target = show ? 1 : 0;
    // Critically-damped-ish ease: fast start, soft landing.
    progress.current += (target - progress.current) * Math.min(1, delta * 3.2);
    if (Math.abs(target - progress.current) < 0.002) progress.current = target;
    const p = progress.current;
    g.visible = p > 0.01;
    g.scale.set(1, Math.max(0.001, p), 1);
  });

  return <group ref={ref}>{children}</group>;
}

function CameraRig({ reducedMotion }: { reducedMotion: boolean }) {
  const { camera, size } = useThree();
  const cam = camera as THREE.PerspectiveCamera;

  // Push the city toward the lower-right (desktop) or lower half (phones) so the headline has clear sky.
  useEffect(() => {
    const wide = size.width >= 900;
    cam.setViewOffset(
      size.width,
      size.height,
      wide ? -size.width * 0.17 : 0,
      wide ? -size.height * 0.04 : -size.height * 0.22,
      size.width,
      size.height
    );
    cam.updateProjectionMatrix();
    return () => cam.clearViewOffset();
  }, [cam, size.width, size.height]);

  useFrame(({ clock }) => {
    const t = reducedMotion ? 0 : clock.elapsedTime;
    // Intro: start high and far, settle into a low cinematic orbit while the city builds.
    const intro = reducedMotion ? 1 : 1 - Math.pow(1 - Math.min(1, t / 11), 3);
    const radius = THREE.MathUtils.lerp(3400, 1900, intro);
    const height = THREE.MathUtils.lerp(2600, 800, intro);
    // Sway across a side-on arc instead of orbiting all the way round: a full orbit eventually looks straight
    // down the motorway, hiding the viaduct and making the whole city look like one thin line.
    const az = 0.55 + Math.sin(t * 0.09) * 0.45;
    cam.position.set(Math.sin(az) * radius, height, Math.cos(az) * radius);
    cam.lookAt(0, 40, 0);
  });

  return null;
}

export default function HeroScene({
  stage,
  snapshotRef,
  visible,
  reducedMotion,
}: {
  stage: number;
  snapshotRef: RefObject<VehicleSnapshot | null>;
  visible: boolean;
  reducedMotion: boolean;
}) {
  const q = useGraphics();
  const glEpoch = useGlEpoch();
  const city = useMemo(() => getDemoCity(), []);
  const avoid = useMemo(() => getDemoRoadSegments(), []);

  return (
    <Canvas
      key={glEpoch}
      shadows={q.shadows}
      dpr={q.dpr}
      // FrameLimiter drives frames: capped rate, and no rendering at all while the hero is off-screen.
      frameloop="never"
      gl={{ antialias: q.antialias, powerPreference: "default" }}
      camera={{ fov: 30, near: 50, far: 30000, position: [2000, 3800, 2500] }}
    >
      {visible && <FrameLimiter maxFps={q.maxFps} active />}
      <color attach="background" args={[HAZE]} />
      <fog attach="fog" args={[HAZE, 4200, 12500]} />

      <hemisphereLight intensity={0.75} color="#fff1dc" groundColor="#7cc77c" />
      <ambientLight intensity={0.3} />
      <directionalLight
        position={[-1600, 950, 1100]}
        intensity={1.5}
        color="#ffe2b8"
        castShadow={q.shadows}
        shadow-mapSize-width={q.shadowMapSize}
        shadow-mapSize-height={q.shadowMapSize}
        shadow-camera-left={-3000}
        shadow-camera-right={3000}
        shadow-camera-top={2600}
        shadow-camera-bottom={-2600}
        shadow-camera-near={10}
        shadow-camera-far={6000}
        shadow-bias={-0.0004}
      />

      <CameraRig reducedMotion={reducedMotion} />
      <Terrain treeCount={Math.round(1100 * q.scenery)} avoid={avoid} clearance={90} />

      {city.stages.map((slice, i) => (
        <Rise key={i} show={stage > i}>
          <RoadNetworkMesh networkOverride={slice} />
        </Rise>
      ))}

      <VehicleRenderer snapshotRef={snapshotRef} />
    </Canvas>
  );
}
