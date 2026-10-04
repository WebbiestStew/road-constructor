"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { assembleCached } from "@/sim/assembleCache";
import { laneCenterPointAt } from "@/sim/laneGeometry";
import { useEditorStore } from "@/state/editorStore";
import { useDetailShed } from "@/lib/perfDetail";

/** Signal heads at the stop line of every signalled approach: a pole with a light that shows what the phase plan says. */

const POLE_HEIGHT_FT = 15;
const COLORS = [new THREE.Color("#ff2b2b"), new THREE.Color("#2dff7a"), new THREE.Color("#2de6ff"), new THREE.Color("#ffb020")];
const poleGeometry = new THREE.BoxGeometry(0.7, POLE_HEIGHT_FT, 0.7);
const headGeometry = new THREE.BoxGeometry(2.6, 2.6, 2.6);
const poleMaterial = new THREE.MeshStandardMaterial({ color: "#2a2d36", roughness: 0.7 });
const headMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });

function SignalHeads({ heads }: { heads: [string, number][] }) {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const network = useMemo(() => assembleCached(nodes, edges), [nodes, edges]);
  const shed = useDetailShed();
  const simulating = useEditorStore((s) => s.mode === "simulate");

  const placements = useMemo(() => {
    const out: { id: string; x: number; y: number; z: number }[] = [];
    const tan = new THREE.Vector3();
    const right = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const e of network.edges) {
      const node = network.nodesById.get(e.toNodeId);
      if (node?.control?.type !== "signal" || e.length < 30) continue;
      const t = Math.max(0.5, 1 - 9 / e.length);
      laneCenterPointAt(e, t, e.lanes - 1, tan, right, p);
      p.addScaledVector(right, e.laneWidthFt / 2 + 3.2);
      out.push({ id: e.id, x: p.x, y: p.y, z: p.z });
    }
    return out;
  }, [network]);

  const poles = useRef<THREE.InstancedMesh>(null);
  const lights = useRef<THREE.InstancedMesh>(null);
  const indexOf = useMemo(() => new Map(placements.map((pl, i) => [pl.id, i])), [placements]);

  useEffect(() => {
    const pm = poles.current;
    const lm = lights.current;
    if (!pm || !lm) return;
    const m = new THREE.Matrix4();
    placements.forEach((pl, i) => {
      m.makeTranslation(pl.x, pl.y + POLE_HEIGHT_FT / 2, pl.z);
      pm.setMatrixAt(i, m);
      m.makeTranslation(pl.x, pl.y + POLE_HEIGHT_FT + 1, pl.z);
      lm.setMatrixAt(i, m);
      lm.setColorAt(i, COLORS[0]);
    });
    pm.count = lm.count = placements.length;
    pm.instanceMatrix.needsUpdate = true;
    lm.instanceMatrix.needsUpdate = true;
    if (lm.instanceColor) lm.instanceColor.needsUpdate = true;
  }, [placements]);

  useEffect(() => {
    const lm = lights.current;
    if (!lm || heads.length === 0) return;
    for (const [id, state] of heads) {
      const i = indexOf.get(id);
      if (i !== undefined) lm.setColorAt(i, COLORS[state] ?? COLORS[0]);
    }
    if (lm.instanceColor) lm.instanceColor.needsUpdate = true;
  }, [heads, indexOf]);

  if (placements.length === 0 || shed >= 2 || !simulating) return null;
  return (
    <>
      <instancedMesh key={`p${placements.length}`} ref={poles} args={[poleGeometry, poleMaterial, placements.length]} frustumCulled={false} />
      <instancedMesh key={`l${placements.length}`} ref={lights} args={[headGeometry, headMaterial, placements.length]} frustumCulled={false} />
    </>
  );
}

export default memo(SignalHeads);
