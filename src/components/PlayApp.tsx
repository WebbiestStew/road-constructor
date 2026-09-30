"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import { useState } from "react";
import * as THREE from "three";
import RoadNetworkMesh from "@/components/RoadNetworkMesh";
import RoadEditor from "@/components/RoadEditor";
import VehicleRenderer from "@/components/VehicleRenderer";
import SimControls from "@/components/SimControls";
import Terrain from "@/components/Terrain";
import CameraFit from "@/components/CameraFit";
import KeyboardPan from "@/components/KeyboardPan";
import { useTrafficSimulation } from "@/hooks/useTrafficSimulation";
import { useScenarioRunner } from "@/hooks/useScenarioRunner";
import FallbackScreen from "@/components/FallbackScreen";
import PerfGuard from "@/components/PerfGuard";
import { useQuality } from "@/lib/quality";
import { useEditorStore } from "@/state/editorStore";
import { SCENARIOS } from "@/sim/scenarios";
import { useWebGLSupported } from "@/lib/webgl";

/** Steep top-down-ish default camera direction, in feet, looking at the origin where building starts. Orthographic, so only the angle matters — not the distance. */
const CAMERA_POSITION: [number, number, number] = [300, 650, 300];

// Dev-only handle for poking the editor from the console while testing.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __rc: unknown }).__rc = { store: useEditorStore, scenarios: SCENARIOS };
}

export default function PlayApp() {
  const sim = useTrafficSimulation();
  const scenarioRunner = useScenarioRunner(sim);
  const quality = useQuality();
  const webglSupported = useWebGLSupported();
  const [contextLost, setContextLost] = useState(false);
  const high = quality === "high";

  if (!webglSupported) {
    return (
      <FallbackScreen title="Your browser can't draw 3D">
        <p>Road Constructor needs WebGL. Try enabling hardware acceleration, or use a recent Chrome, Edge, Firefox, or Safari.</p>
      </FallbackScreen>
    );
  }

  if (contextLost) {
    return (
      <FallbackScreen title="The graphics card gave up" actionLabel="Reload" onAction={() => window.location.reload()}>
        <p>The 3D view was lost (usually a GPU reset or too many tabs). Your network is autosaved.</p>
      </FallbackScreen>
    );
  }

  if (sim.workerFailed) {
    return (
      <FallbackScreen title="The simulator crashed" actionLabel="Reload" onAction={() => window.location.reload()}>
        <p>The traffic engine stopped unexpectedly. Your network is autosaved. This is a beta, so please send feedback if it repeats.</p>
      </FallbackScreen>
    );
  }

  return (
    <div id="sim-root">
      <Canvas
        // gl options are fixed at creation, so switching quality remounts the canvas.
        key={quality}
        shadows={high}
        dpr={high ? [1, 2] : 1}
        gl={{ antialias: high, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", (e) => {
            e.preventDefault();
            setContextLost(true);
          });
        }}
      >
        <PerfGuard />
        <CameraFit />
        <color attach="background" args={["#bff0c8"]} />
        <fog attach="fog" args={["#bff0c8", 4200, 13000]} />

        <OrthographicCamera makeDefault position={CAMERA_POSITION} zoom={1.05} near={1} far={20000} />

        <hemisphereLight intensity={0.7} color="#fff6e0" groundColor="#5fb85f" />
        <ambientLight intensity={0.35} />
        <directionalLight
          position={[900, 1000, 500]}
          intensity={1.35}
          castShadow={high}
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

        <KeyboardPan />
        <OrbitControls
          makeDefault
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
