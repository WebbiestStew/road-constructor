"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useEditorStore } from "@/state/editorStore";
import { assembleNetwork } from "@/sim/network";

const LAMP_SPACING_FT = 180;
const LAMP_HEIGHT_FT = 22;
/** How far the pole is set back from the road's own centerline-relative edge (paved width + shoulder + barrier), so the pole itself never lands in a lane or through a Jersey barrier/parapet. */
const POLE_CLEARANCE_FT = 3;
/** Fixed shoulder width assumed for clearance purposes — matches roadGeometry's own paving convention. */
const SHOULDER_FT = 4;
/** How far the cobra-head arm reaches back in over the road from the pole, like a real streetlight overhanging its first lane. */
const ARM_REACH_FT = 6;
const MAX_LAMPS = 160;

interface LampFixture {
  /** Pole base, at ground level. */
  base: THREE.Vector3;
  /** Lamp head position, out over the road at fixture height. */
  head: THREE.Vector3;
  /** Ground point directly under the head, for the light-pool decal. */
  poolCenter: THREE.Vector3;
  rotationY: number;
}

const _pos = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _side = new THREE.Vector3();
const _poleMatrix = new THREE.Matrix4();
const _armMatrix = new THREE.Matrix4();
const _bulbMatrix = new THREE.Matrix4();
const _poolMatrix = new THREE.Matrix4();
// A plane's default normal is +Z; lay it flat facing +Y (the same fixed
// rotation for every light pool, since a radial gradient is rotationally
// symmetric anyway — no need to vary this per instance).
const _poolQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _poolScale = new THREE.Vector3(1, 1, 1);

/** Lamp fixture placements along non-loop road edges, alternating sides, cleared of the actual paved width + shoulder + barrier for that road class. Only meaningful at dusk/night. */
function computeLampFixtures(network: ReturnType<typeof assembleNetwork>): LampFixture[] {
  const fixtures: LampFixture[] = [];
  const seenPairs = new Set<string>();
  for (const edge of network.edges) {
    if (edge.isRoundaboutRing || edge.isTexasTurnaround) continue;
    const key = [edge.fromNodeId, edge.toNodeId].sort().join("|");
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    if (edge.length < LAMP_SPACING_FT * 0.6) continue;

    const pavedHalfWidth = (edge.lanes * edge.laneWidthFt) / 2;
    const poleOffsetFt = pavedHalfWidth + SHOULDER_FT + POLE_CLEARANCE_FT;

    const count = Math.max(1, Math.floor(edge.length / LAMP_SPACING_FT));
    for (let i = 1; i <= count && fixtures.length < MAX_LAMPS; i++) {
      const t = i / (count + 1);
      edge.spline.getPointAt(t, _pos);
      edge.spline.getTangentAt(t, _tangent);
      _side.set(-_tangent.z, 0, _tangent.x).normalize();
      const sign = i % 2 === 0 ? 1 : -1;
      const base = new THREE.Vector3(
        _pos.x + _side.x * poleOffsetFt * sign,
        _pos.y,
        _pos.z + _side.z * poleOffsetFt * sign
      );
      // The cobra-head arm reaches back toward the road from the pole, so
      // the fixture actually lights the pavement instead of the shoulder.
      const armDirX = -_side.x * sign;
      const armDirZ = -_side.z * sign;
      const head = new THREE.Vector3(base.x + armDirX * ARM_REACH_FT, base.y + LAMP_HEIGHT_FT, base.z + armDirZ * ARM_REACH_FT);
      // Matches the same atan2(v.x, v.z) convention roadGeometry.ts uses to
      // align a box's local-X dimension along a horizontal direction vector.
      const rotationY = Math.atan2(armDirX, armDirZ);
      fixtures.push({ base, head, poolCenter: new THREE.Vector3(head.x, base.y + 0.08, head.z), rotationY });
    }
    if (fixtures.length >= MAX_LAMPS) break;
  }
  return fixtures;
}

/** A soft radial-gradient sprite for the warm light pool under each fixture — generated on a canvas rather than shipping an image asset. */
function createGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255, 214, 140, 0.65)");
  gradient.addColorStop(0.5, "rgba(255, 200, 120, 0.28)");
  gradient.addColorStop(1, "rgba(255, 200, 120, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Procedural cobra-head lamp posts along every road, glowing with an arm-mounted fixture and a warm ground light-pool at dusk/night — no light-emitting geometry rendered during the day, and no dynamic per-pole lights (all emissive + instanced, so the light budget stays flat regardless of network size). */
export default function Streetlights() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const timeOfDay = useEditorStore((s) => s.timeOfDay);

  const network = useMemo(() => assembleNetwork({ nodes, edges }), [nodes, edges]);
  const fixtures = useMemo(() => computeLampFixtures(network), [network]);
  const glowTexture = useMemo(() => createGlowTexture(), []);

  const poleRef = useRef<THREE.InstancedMesh>(null);
  const armRef = useRef<THREE.InstancedMesh>(null);
  const bulbRef = useRef<THREE.InstancedMesh>(null);
  const poolRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const pole = poleRef.current;
    const arm = armRef.current;
    const bulb = bulbRef.current;
    const pool = poolRef.current;
    if (!pole || !arm || !bulb || !pool) return;

    fixtures.forEach((fixture, i) => {
      _poleMatrix.makeRotationY(fixture.rotationY);
      _poleMatrix.setPosition(fixture.base.x, fixture.base.y + LAMP_HEIGHT_FT / 2, fixture.base.z);
      pole.setMatrixAt(i, _poleMatrix);

      const armMidX = (fixture.base.x + fixture.head.x) / 2;
      const armMidZ = (fixture.base.z + fixture.head.z) / 2;
      _armMatrix.makeRotationY(fixture.rotationY);
      _armMatrix.setPosition(armMidX, fixture.base.y + LAMP_HEIGHT_FT, armMidZ);
      arm.setMatrixAt(i, _armMatrix);

      _bulbMatrix.makeTranslation(fixture.head.x, fixture.head.y - 0.6, fixture.head.z);
      bulb.setMatrixAt(i, _bulbMatrix);

      _poolMatrix.compose(fixture.poolCenter, _poolQuat, _poolScale);
      pool.setMatrixAt(i, _poolMatrix);
    });

    pole.count = fixtures.length;
    arm.count = fixtures.length;
    bulb.count = fixtures.length;
    pool.count = fixtures.length;
    pole.instanceMatrix.needsUpdate = true;
    arm.instanceMatrix.needsUpdate = true;
    bulb.instanceMatrix.needsUpdate = true;
    pool.instanceMatrix.needsUpdate = true;
  }, [fixtures]);

  if (timeOfDay === "day" || fixtures.length === 0) return null;

  return (
    <group>
      <instancedMesh ref={poleRef} args={[undefined, undefined, MAX_LAMPS]} frustumCulled={false} castShadow>
        <cylinderGeometry args={[0.6, 0.8, LAMP_HEIGHT_FT, 6]} />
        <meshStandardMaterial color="#3f3f46" roughness={0.7} />
      </instancedMesh>
      <instancedMesh ref={armRef} args={[undefined, undefined, MAX_LAMPS]} frustumCulled={false} castShadow>
        <boxGeometry args={[ARM_REACH_FT, 0.5, 0.5]} />
        <meshStandardMaterial color="#3f3f46" roughness={0.7} />
      </instancedMesh>
      <instancedMesh ref={bulbRef} args={[undefined, undefined, MAX_LAMPS]} frustumCulled={false}>
        <sphereGeometry args={[1.6, 8, 8]} />
        <meshStandardMaterial color="#ffd27a" emissive="#ffd27a" emissiveIntensity={2.4} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={poolRef} args={[undefined, undefined, MAX_LAMPS]} frustumCulled={false} renderOrder={1}>
        <planeGeometry args={[26, 26]} />
        <meshBasicMaterial
          map={glowTexture}
          transparent
          opacity={0.5}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
}
