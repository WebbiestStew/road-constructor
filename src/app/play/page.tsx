"use client";

import { useEffect, useMemo, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import { Bloom, EffectComposer, SSAO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { BlendFunction, ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import RoadNetworkMesh from "@/components/RoadNetworkMesh";
import RoadEditor from "@/components/RoadEditor";
import VehicleRenderer from "@/components/VehicleRenderer";
import Pedestrians from "@/components/Pedestrians";
import RoadsideProps from "@/components/RoadsideProps";
import Scenery from "@/components/Scenery";
import ChallengeLoader from "@/components/ChallengeLoader";
import TransitLines from "@/components/TransitLines";
import EmergencyPins from "@/components/EmergencyPins";
import LightTrails from "@/components/LightTrails";
import FlyoverDirector from "@/components/FlyoverDirector";
import { useFlyover } from "@/lib/cinematic";
import SoundscapeDriver from "@/components/SoundscapeDriver";
import IncidentPins from "@/components/IncidentPins";
import { getScenarioById } from "@/sim/scenarios";
import Curbs from "@/components/Curbs";
import RoundaboutDetails from "@/components/RoundaboutDetails";
import SignalHeads from "@/components/SignalHeads";
import RagePins from "@/components/RagePins";
import StreetNames from "@/components/StreetNames";
import FreewaySigns from "@/components/FreewaySigns";
import ManagementOverlays from "@/components/ManagementOverlays";
import TurnBanSigns from "@/components/TurnBanSigns";
import RampMeters from "@/components/RampMeters";
import LandUseZones from "@/components/LandUseZones";
import RoadClosures from "@/components/RoadClosures";
import SimControls from "@/components/SimControls";
import Terrain from "@/components/Terrain";
import { useTrafficSimulation } from "@/hooks/useTrafficSimulation";
import { useScenarioRunner } from "@/hooks/useScenarioRunner";
import { updateAmbience, updateEngineDynamics } from "@/lib/sound";
import { useEditorStore, type EditorTool } from "@/state/editorStore";
import { decodeShareHash } from "@/state/persistence";
import Streetlights from "@/components/Streetlights";
import ScenarioTerrainFeature from "@/components/ScenarioTerrainFeature";
import JointClackDetector from "@/components/JointClackDetector";
import ChaseCamera from "@/components/ChaseCamera";
import AutosaveHydrator from "@/components/AutosaveHydrator";
import FallbackScreen from "@/components/FallbackScreen";
import KeyboardPan from "@/components/KeyboardPan";
import PhotoRig from "@/components/PhotoRig";
import { WorldLabelLayer, WorldLabelProjector } from "@/components/WorldLabels";
import { togglePhotoMode, usePhotoMode } from "@/lib/photoMode";
import PerfGuard from "@/components/PerfGuard";
import { useGlEpoch, useGraphics, useHydrated, useQuality } from "@/lib/quality";
import FrameLimiter from "@/components/FrameLimiter";
import { useWebGLSupported } from "@/lib/webgl";

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
          const cx = (minX + maxX) / 2;
          const cz = (minZ + maxZ) / 2;
          // Zoom so the whole shared city is in view, not just centred.
          const radius = Math.max(maxX - minX, maxZ - minZ) / 2 + Math.hypot(cx, cz);
          requestCameraFit({ centerX: cx, centerZ: cz, radiusFt: 1.2 * radius });
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
const CAMERA_DIRECTION: [number, number, number] = [300, 650, 300];
/**
 * How far back along that direction the camera sits. It has to be far: an orthographic camera clips anything
 * nearer than its own plane, so a camera only ~780 ft up loses the whole bottom of the screen to empty sky
 * the moment you zoom out over a large network.
 */
const CAMERA_DISTANCE_FT = 4800;
const CAMERA_POSITION: [number, number, number] = (() => {
  const d = new THREE.Vector3(...CAMERA_DIRECTION).normalize().multiplyScalar(CAMERA_DISTANCE_FT);
  return [d.x, d.y, d.z];
})();
/** The ground plane now sits this much farther from the camera than before, so the fog band moves back by the same amount. */
const FOG_OFFSET_FT = CAMERA_DISTANCE_FT - new THREE.Vector3(...CAMERA_DIRECTION).length();

/** Orthographic zoom range from the OrbitControls below the canvas — used to map zoom to the ambient hum/engine crossfade. */
const MIN_ZOOM = 0.02;
/** The zoom range the ambient mix was tuned over (the camera can now go out farther, for the biggest maps). */
const AMBIENCE_MIN_ZOOM = 0.08;
const MAX_ZOOM = 12;

const _cameraDir = new THREE.Vector3(...CAMERA_POSITION).normalize();
const _cameraDist = new THREE.Vector3(...CAMERA_POSITION).length();

/** Recenters the orthographic camera + its OrbitControls target on a requested bounding box (e.g. right after a share-link import), then clears the request. No visual output. */
function CameraFitController() {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const size = useThree((s) => s.size);
  const pendingCameraFit = useEditorStore((s) => s.pendingCameraFit);
  const clearPendingCameraFit = useEditorStore((s) => s.clearPendingCameraFit);

  useEffect(() => {
    if (!pendingCameraFit || !controls) return;
    const { centerX, centerZ, radiusFt } = pendingCameraFit;
    if (radiusFt !== undefined) {
      // Zoom so the whole network fits. The default view is a steep oblique (the ground foreshortens), so leave a margin.
      const span = Math.max(radiusFt, 200) * 2 * 1.25;
      const fitZoom = THREE.MathUtils.clamp(Math.min(size.width, size.height * 1.25) / span, MIN_ZOOM, 4);
      // eslint-disable-next-line react-hooks/immutability -- the orthographic camera is three.js state we're meant to drive directly
      camera.zoom = fitZoom;
      camera.updateProjectionMatrix();
    }
    const target = new THREE.Vector3(centerX, 0, centerZ);
    // Recenter on the new target while preserving the current viewing
    // angle/zoom: set position and target directly (matching OrbitControls'
    // own target+offset model) rather than driving this through its dolly
    // API, then let update() resync its internal spherical state from them.
    camera.position.copy(target).addScaledVector(_cameraDir, _cameraDist);
    controls.target.copy(target);
    controls.update();
    clearPendingCameraFit();
  }, [pendingCameraFit, camera, controls, clearPendingCameraFit, size.width, size.height]);

  return null;
}

/** Drives the ambient audio bed from camera zoom and live traffic speed every frame — no visual output. */
function AmbienceController({ avgSpeedMph }: { avgSpeedMph: number }) {
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const zoom = (camera as THREE.OrthographicCamera).zoom ?? AMBIENCE_MIN_ZOOM;
    const logMin = Math.log(AMBIENCE_MIN_ZOOM);
    const logMax = Math.log(MAX_ZOOM);
    const t = (Math.log(Math.max(AMBIENCE_MIN_ZOOM, zoom)) - logMin) / (logMax - logMin);
    updateAmbience(t);
    updateEngineDynamics(avgSpeedMph);
  });
  return null;
}

/** Which tools are "aim and place something new" (crosshair) vs. "click an existing thing" (default pointer) — a small but real cue for what a click will do, especially since Simulate mode's Inspect tool now reveals a live stats panel rather than editing anything. */
const CROSSHAIR_TOOLS = new Set<EditorTool>(["draw", "zone", "turnaround", "landuse"]);

export default function Play() {
  const sim = useTrafficSimulation();
  const flyover = useFlyover();
  const texasMap = useEditorStore((s) => (s.activeScenarioId ? getScenarioById(s.activeScenarioId)?.texas === true : false));
  // Dev builds only: `__sim` lets the browser console read the live simulation state.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") (window as unknown as { __sim: unknown }).__sim = sim;
  });
  const scenarioRunner = useScenarioRunner(sim);
  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  const rideAlongActive = useEditorStore((s) => s.rideAlongActive);
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const weather = sim.metrics.weather;
  const baseSky = timeOfDay === "night" ? SKY_COLOR_NIGHT : timeOfDay === "dusk" ? SKY_COLOR_DUSK : SKY_COLOR_DAY;
  // Rain greys the sky and fog whitens it, so the horizon matches the overlay instead of staying sunny.
  const skyColor = useMemo(() => {
    if (weather === "clear") return baseSky;
    return new THREE.Color(baseSky).lerp(new THREE.Color(weather === "rain" ? "#6f8096" : "#cfd6dc"), 0.55).getStyle();
  }, [baseSky, weather]);
  // Wet pavement follows the sim's weather, including a scripted storm.
  useEffect(() => {
    useEditorStore.setState({ roadsWet: weather === "rain" });
  }, [weather]);
  const canvasCursor = mode === "build" && CROSSHAIR_TOOLS.has(tool) ? "crosshair" : "default";
  const quality = useQuality();
  const q = useGraphics();
  const glEpoch = useGlEpoch();
  const webglSupported = useWebGLSupported();
  const hydrated = useHydrated();
  const photoMode = usePhotoMode();

  // H toggles photo mode and Esc leaves it. This lives here (not in the HUD) because the HUD is hidden in photo mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.toLowerCase() === "h") togglePhotoMode();
      else if (e.key === "Escape" && photoMode) togglePhotoMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoMode]);
  const [contextLost, setContextLost] = useState(false);

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

  // The saved graphics quality is only known on the client; mounting the canvas before it settles would mount a
  // second, throwaway canvas (and log a React unmount error) when it flips from the default to the saved value.
  if (!hydrated) return <div id="sim-root" />;

  return (
    <div id="sim-root">
      <AutosaveHydrator />
      <ShareLinkLoader />
      <ChallengeLoader runner={scenarioRunner} />
      <Canvas
        // gl options are fixed at creation, so switching quality remounts the canvas.
        key={glEpoch}
        shadows={q.shadows}
        dpr={q.dpr}
        // We drive frames ourselves (FrameLimiter): capped rate, and a trickle while idle.
        frameloop="never"
        gl={{ antialias: q.antialias, powerPreference: "default" }}
        style={{ cursor: canvasCursor }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", (e) => {
            e.preventDefault();
            setContextLost(true);
          });
        }}
      >
        <FrameLimiter maxFps={q.maxFps} active={sim.running || rideAlongActive || photoMode} />
        <PhotoRig />
        <WorldLabelProjector />
        <PerfGuard active={sim.running} />
        <KeyboardPan />
        <color attach="background" args={[skyColor]} />
        <fog attach="fog" args={[skyColor, (weather === "fog" ? 900 : 4200) + FOG_OFFSET_FT, (weather === "fog" ? 4200 : 13000) + FOG_OFFSET_FT]} />

        <OrthographicCamera makeDefault position={CAMERA_POSITION} zoom={1.05} near={1} far={60000} />

        {timeOfDay === "night" ? (
          <>
            <hemisphereLight intensity={0.16} color="#5b6fb0" groundColor="#0a0c1c" />
            <ambientLight intensity={0.09} />
            <directionalLight
              position={[-700, 900, -400]}
              intensity={0.18}
              color="#7c8fd9"
              castShadow={q.shadows}
              shadow-mapSize-width={q.shadowMapSize}
              shadow-mapSize-height={q.shadowMapSize}
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
              castShadow={q.shadows}
              shadow-mapSize-width={q.shadowMapSize}
              shadow-mapSize-height={q.shadowMapSize}
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
            <hemisphereLight intensity={0.5} color="#fff6e0" groundColor="#5fb85f" />
            <ambientLight intensity={0.26} />
            <directionalLight
              position={[900, 1000, 500]}
              intensity={1.6}
              castShadow={q.shadows}
              shadow-mapSize-width={q.shadowMapSize}
              shadow-mapSize-height={q.shadowMapSize}
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
          incidentMarkers={sim.metrics.incidentMarkers}
        />
        <Curbs />
        <RoundaboutDetails />
        <SignalHeads heads={sim.metrics.signalHeads} />
        <Streetlights />
        <RoadsideProps />
        <Scenery />
        <TransitLines />
        <RoadEditor />
        <VehicleRenderer snapshotRef={sim.snapshotRef} />
        <Pedestrians snapshotRef={sim.snapshotRef} />
        <ManagementOverlays />
        <FreewaySigns />
        <TurnBanSigns />
        <RampMeters meters={sim.metrics.meters} />
        <LandUseZones />
        <RoadClosures closed={sim.metrics.closedEdges} />
        <StreetNames />
        {flyover && <LightTrails snapshotRef={sim.snapshotRef} />}
        <SoundscapeDriver snapshotRef={sim.snapshotRef} wet={weather === "rain"} running={sim.running} texas={texasMap} avgMph={sim.metrics.avgSpeedMph} rageMarkers={sim.metrics.rageMarkers} rageCount={sim.metrics.rageCount} />
        {sim.running && <RagePins markers={sim.metrics.rageMarkers} />}
        <IncidentPins incidents={sim.metrics.incidents} onDispatch={sim.dispatchWrecker} />
        <EmergencyPins snapshotRef={sim.snapshotRef} />
        {quality !== "low" && <JointClackDetector snapshotRef={sim.snapshotRef} />}
        <ChaseCamera snapshotRef={sim.snapshotRef} />
        <AmbienceController avgSpeedMph={sim.metrics.avgSpeedMph} />
        <CameraFitController />

        {!rideAlongActive && (
          <OrbitControls
            makeDefault
            target={[0, 0, 0]}
            enableDamping
            dampingFactor={0.08}
            minZoom={MIN_ZOOM}
            maxZoom={12}
            maxPolarAngle={Math.PI / 2 - 0.05}
            mouseButtons={{
              LEFT: -1 as unknown as THREE.MOUSE,
              MIDDLE: THREE.MOUSE.PAN,
              RIGHT: THREE.MOUSE.ROTATE,
            }}
            // Touch: one finger pans (taps still reach the editor), two fingers pinch-zoom and twist-rotate.
            touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
          />
        )}

        {/*
          Always-on pipeline (not gated by timeOfDay) so exposure and color
          response stay consistent across Day/Dusk/Night instead of Day
          rendering raw and the other two suddenly gaining a tone curve.
          Order matters: AO reads the un-tonemapped depth/normal buffers,
          bloom blooms the pre-tonemapped HDR-ish highlights, tone mapping
          compresses to display range last, vignette works on the final image.
        */}
        {q.postprocessing && (
        <EffectComposer multisampling={2} enableNormalPass>
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
        )}
      </Canvas>
      <WorldLabelLayer />

      <FlyoverDirector sim={sim} />
      <SimControls sim={sim} scenarioRunner={scenarioRunner} />
    </div>
  );
}
