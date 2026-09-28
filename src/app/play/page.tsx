"use client";

import { useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import { Bloom, EffectComposer, SSAO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { BlendFunction, ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import RoadNetworkMesh from "@/components/RoadNetworkMesh";
import RoadEditor from "@/components/RoadEditor";
import VehicleRenderer from "@/components/VehicleRenderer";
import SimControls from "@/components/SimControls";
import Terrain from "@/components/Terrain";
import { useTrafficSimulation } from "@/hooks/useTrafficSimulation";
import { useScenarioRunner } from "@/hooks/useScenarioRunner";
import { updateAmbience, updateEngineDynamics } from "@/lib/sound";
import { useEditorStore } from "@/state/editorStore";
import { decodeShareHash } from "@/state/persistence";
import Streetlights from "@/components/Streetlights";
import ScenarioTerrainFeature from "@/components/ScenarioTerrainFeature";
import JointClackDetector from "@/components/JointClackDetector";

const SHARE_HASH_PREFIX = "#data=";

/** Auto-loads a shared network from a `#data=...` URL hash on first mount, if present, then centers the camera on it and opens it straight to traffic. No visual output. */
function ShareLinkLoader() {
  const importPayload = useEditorStore((s) => s.importPayload);
  const requestCameraFit = useEditorStore((s) => s.requestCameraFit);
  const setMode = useEditorStore((s) => s.setMode);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith(SHARE_HASH_PREFIX)) return;
    const encoded = hash.slice(SHARE_HASH_PREFIX.length);
    void decodeShareHash(encoded).then((payload) => {
      if (payload) {
        importPayload(payload);

        const nodes = payload.network.nodes;
        if (nodes.length > 0) {
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (const n of nodes) {
            minX = Math.min(minX, n.position[0]);
            maxX = Math.max(maxX, n.position[0]);
            minZ = Math.min(minZ, n.position[2]);
            maxZ = Math.max(maxZ, n.position[2]);
          }
          requestCameraFit({ centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2 });
        }

        setMode("simulate");
      } else {
        window.alert("That share link looks corrupted or out of date.");
      }
      history.replaceState(null, "", window.location.pathname + window.location.search);
    });
    // Intentionally run once on mount only — a hash present at load time is a one-shot import trigger, not reactive state to watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

const SKY_COLOR_DAY = "#bff0c8";
const SKY_COLOR_DUSK = "#2b2440";
const SKY_COLOR_NIGHT = "#0a0c1c";

/** Steep top-down-ish default camera direction, in feet, looking at the origin where building starts. Orthographic, so only the angle matters — not the distance. */
const CAMERA_POSITION: [number, number, number] = [300, 650, 300];

/** Orthographic zoom range from the OrbitControls below the canvas — used to map zoom to the ambient hum/engine crossfade. */
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 12;

const _cameraDir = new THREE.Vector3(...CAMERA_POSITION).normalize();
const _cameraDist = new THREE.Vector3(...CAMERA_POSITION).length();

/** Recenters the orthographic camera + its OrbitControls target on a requested bounding box (e.g. right after a share-link import), then clears the request. No visual output. */
function CameraFitController() {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const pendingCameraFit = useEditorStore((s) => s.pendingCameraFit);
  const clearPendingCameraFit = useEditorStore((s) => s.clearPendingCameraFit);

  useEffect(() => {
    if (!pendingCameraFit || !controls) return;
    const { centerX, centerZ } = pendingCameraFit;
    const target = new THREE.Vector3(centerX, 0, centerZ);
    // Recenter on the new target while preserving the current viewing
    // angle/zoom: set position and target directly (matching OrbitControls'
    // own target+offset model) rather than driving this through its dolly
    // API, then let update() resync its internal spherical state from them.
    camera.position.copy(target).addScaledVector(_cameraDir, _cameraDist);
    controls.target.copy(target);
    controls.update();
    clearPendingCameraFit();
  }, [pendingCameraFit, camera, controls, clearPendingCameraFit]);

  return null;
}

/** Drives the ambient audio bed from camera zoom and live traffic speed every frame — no visual output. */
function AmbienceController({ avgSpeedMph }: { avgSpeedMph: number }) {
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const zoom = (camera as THREE.OrthographicCamera).zoom ?? MIN_ZOOM;
    const logMin = Math.log(MIN_ZOOM);
    const logMax = Math.log(MAX_ZOOM);
    const t = (Math.log(Math.max(MIN_ZOOM, zoom)) - logMin) / (logMax - logMin);
    updateAmbience(t);
    updateEngineDynamics(avgSpeedMph);
  });
  return null;
}

export default function Play() {
  const sim = useTrafficSimulation();
  const scenarioRunner = useScenarioRunner(sim);
  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  const skyColor =
    timeOfDay === "night" ? SKY_COLOR_NIGHT : timeOfDay === "dusk" ? SKY_COLOR_DUSK : SKY_COLOR_DAY;

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

        {timeOfDay === "night" ? (
          <>
            <hemisphereLight intensity={0.16} color="#5b6fb0" groundColor="#0a0c1c" />
            <ambientLight intensity={0.09} />
            <directionalLight
              position={[-700, 900, -400]}
              intensity={0.18}
              color="#7c8fd9"
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
        ) : timeOfDay === "dusk" ? (
          <>
            <hemisphereLight intensity={0.32} color="#ffb37a" groundColor="#241b3d" />
            <ambientLight intensity={0.16} />
            <directionalLight
              position={[1500, 260, 750]}
              intensity={0.55}
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
        <JointClackDetector snapshotRef={sim.snapshotRef} />
        <AmbienceController avgSpeedMph={sim.metrics.avgSpeedMph} />
        <CameraFitController />

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

        {/*
          Always-on pipeline (not gated by timeOfDay) so exposure and color
          response stay consistent across Day/Dusk/Night instead of Day
          rendering raw and the other two suddenly gaining a tone curve.
          Order matters: AO reads the un-tonemapped depth/normal buffers,
          bloom blooms the pre-tonemapped HDR-ish highlights, tone mapping
          compresses to display range last, vignette works on the final image.
        */}
        <EffectComposer multisampling={4} enableNormalPass>
          <SSAO
            blendFunction={BlendFunction.MULTIPLY}
            samples={8}
            rings={4}
            radius={0.15}
            intensity={1.2}
            luminanceInfluence={0.6}
            bias={0.03}
            fade={0.02}
            resolutionScale={0.5}
          />
          <Bloom
            mipmapBlur
            luminanceThreshold={0.35}
            luminanceSmoothing={0.2}
            intensity={timeOfDay === "night" ? 1.1 : timeOfDay === "dusk" ? 0.75 : 0.12}
          />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          <Vignette offset={0.35} darkness={timeOfDay === "night" ? 0.45 : 0.3} />
        </EffectComposer>
      </Canvas>

      <SimControls sim={sim} scenarioRunner={scenarioRunner} />
    </div>
  );
}
