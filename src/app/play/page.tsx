"use client";

import { useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import * as THREE from "three";
import RoadNetworkMesh from "@/components/RoadNetworkMesh";
import RoadEditor from "@/components/RoadEditor";
import VehicleRenderer from "@/components/VehicleRenderer";
import SimControls from "@/components/SimControls";
import Terrain from "@/components/Terrain";
import { useTrafficSimulation } from "@/hooks/useTrafficSimulation";
import { useScenarioRunner } from "@/hooks/useScenarioRunner";
import { updateAmbience } from "@/lib/sound";
import { useEditorStore } from "@/state/editorStore";
import { decodeShareHash } from "@/state/persistence";
import Streetlights from "@/components/Streetlights";
import ScenarioTerrainFeature from "@/components/ScenarioTerrainFeature";

const SHARE_HASH_PREFIX = "#data=";

/** Auto-loads a shared network from a `#data=...` URL hash on first mount, if present. No visual output. */
function ShareLinkLoader() {
  const importPayload = useEditorStore((s) => s.importPayload);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith(SHARE_HASH_PREFIX)) return;
    const encoded = hash.slice(SHARE_HASH_PREFIX.length);
    void decodeShareHash(encoded).then((payload) => {
      if (payload) importPayload(payload);
      else window.alert("That share link looks corrupted or out of date.");
      history.replaceState(null, "", window.location.pathname + window.location.search);
    });
    // Intentionally run once on mount only — a hash present at load time is a one-shot import trigger, not reactive state to watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

const SKY_COLOR_DAY = "#bff0c8";
const SKY_COLOR_DUSK = "#2b2440";

/** Steep top-down-ish default camera direction, in feet, looking at the origin where building starts. Orthographic, so only the angle matters — not the distance. */
const CAMERA_POSITION: [number, number, number] = [300, 650, 300];

/** Orthographic zoom range from the OrbitControls below the canvas — used to map zoom to the ambient hum/engine crossfade. */
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 12;

/** Drives the ambient audio bed from camera zoom every frame — no visual output. */
function AmbienceController() {
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const zoom = (camera as THREE.OrthographicCamera).zoom ?? MIN_ZOOM;
    const logMin = Math.log(MIN_ZOOM);
    const logMax = Math.log(MAX_ZOOM);
    const t = (Math.log(Math.max(MIN_ZOOM, zoom)) - logMin) / (logMax - logMin);
    updateAmbience(t);
  });
  return null;
}

export default function Play() {
  const sim = useTrafficSimulation();
  const scenarioRunner = useScenarioRunner(sim);
  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  const isDusk = timeOfDay === "dusk";
  const skyColor = isDusk ? SKY_COLOR_DUSK : SKY_COLOR_DAY;

  return (
    <div id="sim-root">
      <ShareLinkLoader />
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={[skyColor]} />
        <fog attach="fog" args={[skyColor, 4200, 13000]} />

        <OrthographicCamera makeDefault position={CAMERA_POSITION} zoom={1.05} near={1} far={20000} />

        {isDusk ? (
          <>
            <hemisphereLight intensity={0.32} color="#ffb37a" groundColor="#241b3d" />
            <ambientLight intensity={0.16} />
            <directionalLight
              position={[900, 1000, 500]}
              intensity={0.5}
              color="#ffb37a"
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
          </>
        ) : (
          <>
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
          </>
        )}

        <Terrain />
        <ScenarioTerrainFeature />
        <RoadNetworkMesh
          contracts={sim.metrics.contracts}
          edgeSpeedRatios={sim.metrics.edgeSpeedRatios}
          problemEdgeIds={sim.metrics.problemEdgeIds}
          gridlockMarkers={sim.metrics.gridlockMarkers}
        />
        <Streetlights />
        <RoadEditor />
        <VehicleRenderer snapshotRef={sim.snapshotRef} />
        <AmbienceController />

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
