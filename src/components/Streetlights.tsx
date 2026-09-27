"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useEditorStore } from "@/state/editorStore";
import { assembleNetwork } from "@/sim/network";

const LAMP_SPACING_FT = 180;
const LAMP_HEIGHT_FT = 22;
const LAMP_OFFSET_FT = 10;
const MAX_LAMPS = 160;

const _pos = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _side = new THREE.Vector3();
const _poleMatrix = new THREE.Matrix4();
const _bulbMatrix = new THREE.Matrix4();

/** Lamp-post base positions along non-roundabout road edges, alternating sides. Only meaningful at dusk. */
function computeLampBases(network: ReturnType<typeof assembleNetwork>): [number, number, number][] {
  const bases: [number, number, number][] = [];
  const seenPairs = new Set<string>();
  for (const edge of network.edges) {
    if (edge.isRoundaboutRing) continue;
    const key = [edge.fromNodeId, edge.toNodeId].sort().join("|");
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    if (edge.length < LAMP_SPACING_FT * 0.6) continue;

    const count = Math.max(1, Math.floor(edge.length / LAMP_SPACING_FT));
    for (let i = 1; i <= count && bases.length < MAX_LAMPS; i++) {
      const t = i / (count + 1);
      edge.spline.getPointAt(t, _pos);
      edge.spline.getTangentAt(t, _tangent);
      _side.set(-_tangent.z, 0, _tangent.x).normalize();
      const sign = i % 2 === 0 ? 1 : -1;
      bases.push([_pos.x + _side.x * LAMP_OFFSET_FT * sign, _pos.y, _pos.z + _side.z * LAMP_OFFSET_FT * sign]);
    }
    if (bases.length >= MAX_LAMPS) break;
  }
  return bases;
}

/** Procedural lamp posts along every road, glowing at dusk and night — no light-emitting geometry rendered during the day. */
export default function Streetlights() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const timeOfDay = useEditorStore((s) => s.timeOfDay);

  const network = useMemo(() => assembleNetwork({ nodes, edges }), [nodes, edges]);
  const lampBases = useMemo(() => computeLampBases(network), [network]);

  const poleRef = useRef<THREE.InstancedMesh>(null);
  const bulbRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const pole = poleRef.current;
    const bulb = bulbRef.current;
    if (!pole || !bulb) return;
    lampBases.forEach(([x, y, z], i) => {
      _poleMatrix.makeTranslation(x, y + LAMP_HEIGHT_FT / 2, z);
      pole.setMatrixAt(i, _poleMatrix);
      _bulbMatrix.makeTranslation(x, y + LAMP_HEIGHT_FT, z);
      bulb.setMatrixAt(i, _bulbMatrix);
    });
    pole.count = lampBases.length;
    bulb.count = lampBases.length;
    pole.instanceMatrix.needsUpdate = true;
    bulb.instanceMatrix.needsUpdate = true;
  }, [lampBases]);

  if (timeOfDay === "day" || lampBases.length === 0) return null;

  return (
    <group>
      <instancedMesh ref={poleRef} args={[undefined, undefined, MAX_LAMPS]} frustumCulled={false} castShadow>
        <cylinderGeometry args={[0.6, 0.8, LAMP_HEIGHT_FT, 6]} />
        <meshStandardMaterial color="#3f3f46" roughness={0.7} />
      </instancedMesh>
      <instancedMesh ref={bulbRef} args={[undefined, undefined, MAX_LAMPS]} frustumCulled={false}>
        <sphereGeometry args={[2.2, 8, 8]} />
        <meshStandardMaterial color="#ffd27a" emissive="#ffd27a" emissiveIntensity={2.4} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
