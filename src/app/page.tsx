"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import RoadNetworkMesh from "@/components/RoadNetworkMesh";
import VehicleRenderer from "@/components/VehicleRenderer";
import SimControls from "@/components/SimControls";
import { useTrafficSimulation } from "@/hooks/useTrafficSimulation";

/** Approximate centroid of the demo interchange, in feet. */
const INTERCHANGE_CENTER: [number, number, number] = [200, 0, 280];
/** Elevated isometric-style default camera position, in feet. */
const CAMERA_POSITION: [number, number, number] = [500, 400, 500];

export default function Home() {
  const sim = useTrafficSimulation();

  return (
    <div id="sim-root">
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: CAMERA_POSITION, fov: 50, near: 1, far: 20000 }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#18181b"]} />
        <fog attach="fog" args={["#18181b", 3200, 9500]} />

        <hemisphereLight intensity={0.45} color="#dbeafe" groundColor="#3f3f46" />
        <ambientLight intensity={0.2} />
        <directionalLight
          position={[900, 1000, 500]}
          intensity={1.5}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-left={-3600}
          shadow-camera-right={3600}
          shadow-camera-top={2200}
          shadow-camera-bottom={-2200}
          shadow-camera-near={10}
          shadow-camera-far={6000}
          shadow-bias={-0.0004}
        />

        <RoadNetworkMesh />
        <VehicleRenderer snapshotRef={sim.snapshotRef} />

        <OrbitControls
          target={INTERCHANGE_CENTER}
          enableDamping
          dampingFactor={0.08}
          minDistance={80}
          maxDistance={6500}
          maxPolarAngle={Math.PI / 2 - 0.02}
        />
      </Canvas>

      <SimControls sim={sim} />
    </div>
  );
}
