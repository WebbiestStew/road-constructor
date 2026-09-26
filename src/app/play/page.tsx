"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import * as THREE from "three";
import RoadNetworkMesh from "@/components/RoadNetworkMesh";
import RoadEditor from "@/components/RoadEditor";
import VehicleRenderer from "@/components/VehicleRenderer";
import SimControls from "@/components/SimControls";
import Terrain from "@/components/Terrain";
import { useTrafficSimulation } from "@/hooks/useTrafficSimulation";
import { useScenarioRunner } from "@/hooks/useScenarioRunner";

/** Steep top-down-ish default camera direction, in feet, looking at the origin where building starts. Orthographic, so only the angle matters — not the distance. */
const CAMERA_POSITION: [number, number, number] = [300, 650, 300];

export default function Play() {
  const sim = useTrafficSimulation();
  const scenarioRunner = useScenarioRunner(sim);

  return (
    <div id="sim-root">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#bff0c8"]} />
        <fog attach="fog" args={["#bff0c8", 4200, 13000]} />

        <OrthographicCamera makeDefault position={CAMERA_POSITION} zoom={1.05} near={1} far={20000} />

        <hemisphereLight intensity={0.7} color="#fff6e0" groundColor="#5fb85f" />
        <ambientLight intensity={0.35} />
        <directionalLight
          position={[900, 1000, 500]}
          intensity={1.35}
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

        <Terrain />
        <RoadNetworkMesh
          contracts={sim.metrics.contracts}
          edgeSpeedRatios={sim.metrics.edgeSpeedRatios}
          problemEdgeIds={sim.metrics.problemEdgeIds}
        />
        <RoadEditor />
        <VehicleRenderer snapshotRef={sim.snapshotRef} />

        <OrbitControls
          target={[0, 0, 0]}
          enableDamping
          dampingFactor={0.08}
          minZoom={0.08}
          maxZoom={12}
          maxPolarAngle={Math.PI / 2 - 0.05}
          mouseButtons={{
            LEFT: -1 as unknown as THREE.MOUSE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE,
          }}
        />
      </Canvas>

      <SimControls sim={sim} scenarioRunner={scenarioRunner} />
    </div>
  );
}
