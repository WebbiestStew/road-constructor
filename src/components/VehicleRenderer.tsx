"use client";

import { useEffect, useMemo, useRef, type RefObject, memo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MAX_VEHICLES, VEHICLE_KIND_BY_CODE, type VehicleKind } from "@/sim/types";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { useGraphics } from "@/lib/quality";
import { KIND_DIMS, vehicleGeometry } from "./vehicleShapes";

interface VehicleRendererProps {
  snapshotRef: RefObject<VehicleSnapshot | null>;
}

const KINDS: VehicleKind[] = ["car", "truck", "bus", "bike", "ambulance", "police"];

/** Copies one vehicle's colour triple into a colour attribute at a slot. */
function putColor(attr: THREE.BufferAttribute, slot: number, src: Float32Array, from: number): void {
  const a = attr.array as Float32Array;
  a[slot * 3] = src[from * 3];
  a[slot * 3 + 1] = src[from * 3 + 1];
  a[slot * 3 + 2] = src[from * 3 + 2];
}

/** Writes a vehicle's matrix into `dst` at `at`: its heading columns scaled by (sx, sy, sz), and its position. */
function putMatrix(dst: Float32Array, at: number, src: Float32Array, from: number, sx: number, sy: number, sz: number): void {
  dst[at] = src[from] * sx;
  dst[at + 1] = src[from + 1] * sx;
  dst[at + 2] = src[from + 2] * sx;
  dst[at + 3] = 0;
  dst[at + 4] = src[from + 4] * sy;
  dst[at + 5] = src[from + 5] * sy;
  dst[at + 6] = src[from + 6] * sy;
  dst[at + 7] = 0;
  dst[at + 8] = src[from + 8] * sz;
  dst[at + 9] = src[from + 9] * sz;
  dst[at + 10] = src[from + 10] * sz;
  dst[at + 11] = 0;
  dst[at + 12] = src[from + 12];
  dst[at + 13] = src[from + 13];
  dst[at + 14] = src[from + 14];
  dst[at + 15] = 1;
}

/**
 * Draws every vehicle. The simulation hands over one matrix per vehicle (position and heading, with its kind and
 * length tucked into two spare slots); this sorts them into one instanced mesh per kind, so each kind keeps its own
 * shape while the whole fleet stays a handful of draw calls. Lights and shadows are separate instanced meshes sized
 * from each kind's real dimensions.
 */
function VehicleRenderer({ snapshotRef }: VehicleRendererProps) {
  const detailed = useGraphics().detailedVehicles;
  const bodyRefs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const headlightRef = useRef<THREE.InstancedMesh>(null);
  const taillightRef = useRef<THREE.InstancedMesh>(null);
  const shadowRef = useRef<THREE.InstancedMesh>(null);
  const lastVersionRef = useRef(0);
  const lightsOn = useEditorStore((s) => s.timeOfDay !== "day");

  // Unit-sized light bars and shadow: each vehicle scales them to its own width, height and length.
  const headlightGeometry = useMemo(() => {
    const geo = new THREE.BoxGeometry(0.82, 0.1, 0.02);
    geo.translate(0, 0.3, 0.5);
    return geo;
  }, []);
  const taillightGeometry = useMemo(() => {
    const geo = new THREE.BoxGeometry(0.82, 0.1, 0.02);
    geo.translate(0, 0.3, -0.5);
    return geo;
  }, []);
  const shadowGeometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1.3, 1.15);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0.002, 0);
    return geo;
  }, []);
  const bodyGeometries = useMemo(() => KINDS.map((k) => vehicleGeometry(k, detailed)), [detailed]);

  useEffect(() => {
    for (const mesh of bodyRefs.current) {
      if (!mesh) continue;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_VEHICLES * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
    }
    const taillights = taillightRef.current;
    if (taillights) {
      taillights.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_VEHICLES * 3), 3);
      taillights.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    for (const m of [headlightRef.current, taillights, shadowRef.current]) {
      if (!m) continue;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
    }
    lastVersionRef.current = 0;
  }, [detailed]);

  useFrame(() => {
    const snapshot = snapshotRef.current;
    const head = headlightRef.current;
    const tail = taillightRef.current;
    const shadow = shadowRef.current;
    if (!snapshot || !head || !tail || !shadow || !tail.instanceColor) return;
    if (snapshot.version === lastVersionRef.current) return;
    lastVersionRef.current = snapshot.version;

    const src = snapshot.matrices;
    const n = snapshot.activeCount;
    const used = [0, 0, 0, 0, 0, 0];
    const headArr = head.instanceMatrix.array as Float32Array;
    const tailArr = tail.instanceMatrix.array as Float32Array;
    const shadowArr = shadow.instanceMatrix.array as Float32Array;

    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const code = Math.min(5, Math.max(0, Math.round(src[o + 3])));
      const kind = VEHICLE_KIND_BY_CODE[code];
      const len = src[o + 7];
      const mesh = bodyRefs.current[code];
      const colorAttr = mesh?.instanceColor;
      if (!mesh || !colorAttr) continue;
      const slot = used[code]++;
      // Cars stretch to their own length; the rigid kinds keep their built shape.
      putMatrix(mesh.instanceMatrix.array as Float32Array, slot * 16, src, o, 1, 1, code === 0 ? len / KIND_DIMS.car.l : 1);
      putColor(colorAttr, slot, snapshot.colors, i);

      // Lights and shadow: the same position and heading, scaled to this kind's real size.
      const dims = KIND_DIMS[kind];
      const sl = code === 0 ? len : dims.l;
      putMatrix(headArr, o, src, o, dims.w, dims.h, sl);
      putMatrix(tailArr, o, src, o, dims.w, dims.h, sl);
      putMatrix(shadowArr, o, src, o, dims.w, dims.h, sl);
      putColor(tail.instanceColor, i, snapshot.taillightColors, i);
    }

    bodyRefs.current.forEach((mesh, k) => {
      if (!mesh || !mesh.instanceColor) return;
      mesh.count = used[k];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    });
    head.count = lightsOn ? n : 0;
    head.instanceMatrix.needsUpdate = true;
    tail.count = n;
    tail.instanceMatrix.needsUpdate = true;
    tail.instanceColor.needsUpdate = true;
    shadow.count = n;
    shadow.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      {KINDS.map((kind, k) => (
        <instancedMesh
          key={`${kind}:${detailed}`}
          ref={(m) => {
            bodyRefs.current[k] = m;
          }}
          args={[bodyGeometries[k], undefined, MAX_VEHICLES]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial vertexColors roughness={0.45} metalness={0.3} />
        </instancedMesh>
      ))}
      <instancedMesh ref={headlightRef} args={[headlightGeometry, undefined, MAX_VEHICLES]}>
        <meshStandardMaterial color="#fff6d0" emissive="#fff6d0" emissiveIntensity={2.6} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={taillightRef} args={[taillightGeometry, undefined, MAX_VEHICLES]}>
        <meshStandardMaterial color="#ff2a2a" emissive="#ff2a2a" emissiveIntensity={1.4} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={shadowRef} args={[shadowGeometry, undefined, MAX_VEHICLES]} frustumCulled={false}>
        <meshBasicMaterial color="#000000" transparent opacity={0.32} depthWrite={false} toneMapped={false} />
      </instancedMesh>
    </>
  );
}

/** Memoized: the game page re-renders several times a second with live traffic stats, and none of this scene depends on them. */
export default memo(VehicleRenderer);
