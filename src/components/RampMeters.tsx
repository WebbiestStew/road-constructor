"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { assembleCached } from "@/sim/assembleCache";
import { laneCenterPointAt } from "@/sim/laneGeometry";
import { useEditorStore } from "@/state/editorStore";

const HEAD_BEFORE_END_FT = 16;
const POLE_FT = 11;

const poleGeometry = new THREE.CylinderGeometry(0.35, 0.35, POLE_FT, 6);
const headGeometry = new THREE.BoxGeometry(1.6, 3.4, 1.2);
const lampGeometry = new THREE.SphereGeometry(0.55, 10, 8);
const poleMaterial = new THREE.MeshStandardMaterial({ color: "#6f7681", roughness: 0.7, metalness: 0.4 });
const headMaterial = new THREE.MeshStandardMaterial({ color: "#14161c", roughness: 0.8 });
const redOn = new THREE.MeshBasicMaterial({ color: "#ff3b30" });
const redOff = new THREE.MeshStandardMaterial({ color: "#3a1210", roughness: 0.6 });
const greenOn = new THREE.MeshBasicMaterial({ color: "#34ff7a" });
const greenOff = new THREE.MeshStandardMaterial({ color: "#10321c", roughness: 0.6 });

interface Placement {
  id: string;
  base: THREE.Vector3;
  rotationY: number;
}

/** A signal head beside every metered ramp, just before the merge: red while the next car must wait, green when one may go. */
function RampMeters({ meters }: { meters: [string, number][] }) {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const placements = useMemo(() => {
    if (!edges.some((e) => (e.meterS ?? 0) > 0 || e.meterAuto)) return [] as Placement[];
    const net = assembleCached(nodes, edges);
    const out: Placement[] = [];
    const tan = new THREE.Vector3();
    const right = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const e of net.edges) {
      if (!(e.meterS > 0 || e.meterAuto) || e.length < HEAD_BEFORE_END_FT * 2) continue;
      laneCenterPointAt(e, 1 - HEAD_BEFORE_END_FT / e.length, e.lanes - 1, tan, right, p);
      p.addScaledVector(right, e.laneWidthFt * 0.5 + 4);
      out.push({ id: e.id, base: p.clone(), rotationY: Math.atan2(-tan.x, -tan.z) });
    }
    return out;
  }, [nodes, edges]);
  const state = useMemo(() => new Map(meters), [meters]);
  if (placements.length === 0) return null;
  return (
    <>
      {placements.map((pl) => {
        const green = (state.get(pl.id) ?? 1) === 1;
        return (
          <group key={pl.id} position={[pl.base.x, pl.base.y, pl.base.z]} rotation={[0, pl.rotationY, 0]}>
            <mesh geometry={poleGeometry} material={poleMaterial} position={[0, POLE_FT / 2, 0]} />
            <mesh geometry={headGeometry} material={headMaterial} position={[0, POLE_FT + 1.4, 0]} />
            <mesh geometry={lampGeometry} material={green ? redOff : redOn} position={[0, POLE_FT + 2.2, 0.75]} />
            <mesh geometry={lampGeometry} material={green ? greenOn : greenOff} position={[0, POLE_FT + 0.6, 0.75]} />
          </group>
        );
      })}
    </>
  );
}

export default memo(RampMeters);
