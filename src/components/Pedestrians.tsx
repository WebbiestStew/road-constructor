"use client";

import { useEffect, useRef, type RefObject, memo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";

/** People on the road at once: a handful per crossing, a few dozen crossings at most. */
const MAX_PEDS = 320;
const PEOPLE_PER_CROSSING = 4;
const PED_COLORS = ["#ef476f", "#ffd166", "#06d6a0", "#118ab2", "#f78c6b", "#8338ec", "#ffffff"];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

/**
 * Pedestrians as small coloured figures walking across a crossing while traffic waits. Driven by the sim's
 * per-tick list of crossings that currently have people on them; nothing here costs anything while nobody is crossing.
 */
function Pedestrians({ snapshotRef }: { snapshotRef: RefObject<VehicleSnapshot | null> }) {
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const lastVersion = useRef(-1);

  useEffect(() => {
    for (const ref of [bodyRef, headRef]) {
      const mesh = ref.current;
      if (!mesh) continue;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
  }, []);

  useFrame(() => {
    const body = bodyRef.current;
    const head = headRef.current;
    const snap = snapshotRef.current;
    if (!body || !head || !snap || snap.version === lastVersion.current) return;
    lastVersion.current = snap.version;

    let n = 0;
    for (const c of snap.pedCrossings) {
      const [cx, cy, cz, rx, rz, halfWidth, progress, dir] = c;
      for (let k = 0; k < PEOPLE_PER_CROSSING && n < MAX_PEDS; k++) {
        // Stagger the group so it looks like people, not a row: each starts a little apart and walks a slightly different line.
        const lag = k * 0.07;
        const t = Math.min(1, Math.max(0, (progress - lag) / (1 - 0.3)));
        const across = (dir > 0 ? t : 1 - t) * 2 - 1;
        const along = (k - (PEOPLE_PER_CROSSING - 1) / 2) * 2.1;
        // The "right" vector is horizontal; walking is along it, spreading is along the road (perpendicular).
        _p.set(cx + rx * across * halfWidth - rz * along, cy + 3.4, cz + rz * across * halfWidth + rx * along);
        _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(rx * dir, rz * dir));
        _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        body.setMatrixAt(n, _m);
        _c.set(PED_COLORS[(k + Math.floor(Math.abs(cx + cz)) + n) % PED_COLORS.length]);
        body.setColorAt(n, _c);
        _p.y += 4.3;
        _m.compose(_p, _q, _s);
        head.setMatrixAt(n, _m);
        n++;
      }
    }
    body.count = n;
    head.count = n;
    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={bodyRef} args={[undefined, undefined, MAX_PEDS]} castShadow>
        <capsuleGeometry args={[1.35, 3.6, 3, 8]} />
        <meshStandardMaterial color="#ffffff" roughness={0.7} />
      </instancedMesh>
      <instancedMesh ref={headRef} args={[undefined, undefined, MAX_PEDS]}>
        <sphereGeometry args={[1.25, 8, 6]} />
        <meshStandardMaterial color="#f1c9a5" roughness={0.8} />
      </instancedMesh>
    </>
  );
}

export default memo(Pedestrians);
