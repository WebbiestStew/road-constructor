"use client";

import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { MAX_VEHICLES } from "@/sim/types";
import { useDetailShed } from "@/lib/perfDetail";

/** Samples kept per vehicle, newest first. */
const SAMPLES = 30;
/** Real seconds between samples. */
const SAMPLE_EVERY_S = 0.1;
const HEIGHT_FT = 1.4;
/** A vehicle that moves farther than this between samples jumped (left the map, or the run restarted), so its trail starts over. */
const JUMP_FT = 150;
/** A taillight at least this bright counts as braking. */
const BRAKE_LEVEL = 0.95;

interface TrailBuffers {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  colors: Float32Array;
  /** Recent positions (newest first, x y z each) of every vehicle on the road, by vehicle id. */
  histories: Map<number, Float32Array>;
}

/** Adds one sample of every vehicle's position to its ribbon and rewrites the ribbons' vertices. */
function sampleTrails(t: TrailBuffers, snap: VehicleSnapshot, halfWidth: number): void {
  const { positions, colors, geometry, histories } = t;
  const n = Math.min(snap.activeCount, MAX_VEHICLES);
  const m = snap.matrices;
  const tl = snap.taillightColors;
  const seen = new Set<number>();

  for (let v = 0; v < n; v++) {
    const id = m[v * 16 + 11];
    const x = m[v * 16 + 12];
    const y = m[v * 16 + 13] + HEIGHT_FT;
    const z = m[v * 16 + 14];
    seen.add(id);
    let h = histories.get(id);
    if (!h || Math.hypot(x - h[0], z - h[2]) > JUMP_FT) {
      // A new vehicle, or one that jumped (it left the map and came back, or the run restarted): start its trail over.
      h = new Float32Array(SAMPLES * 3);
      for (let k = 0; k < SAMPLES; k++) {
        h[k * 3] = x;
        h[k * 3 + 1] = y;
        h[k * 3 + 2] = z;
      }
      histories.set(id, h);
    } else {
      h.copyWithin(3, 0, (SAMPLES - 1) * 3);
      h[0] = x;
      h[1] = y;
      h[2] = z;
    }

    const braking = tl[v * 3] > BRAKE_LEVEL;
    const r = 1;
    const g = braking ? 0.1 : 0.78;
    const b = braking ? 0.06 : 0.42;
    for (let k = 0; k < SAMPLES; k++) {
      const p = k * 3;
      const q = Math.min(k + 1, SAMPLES - 1) * 3;
      const p0 = Math.max(k - 1, 0) * 3;
      let dx = h[p0] - h[q];
      let dz = h[p0 + 2] - h[q + 2];
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) {
        dx = 1;
        dz = 0;
      } else {
        dx /= len;
        dz /= len;
      }
      const px = -dz * halfWidth;
      const pz = dx * halfWidth;
      const vert = (v * SAMPLES + k) * 6;
      positions[vert] = h[p] + px;
      positions[vert + 1] = h[p + 1];
      positions[vert + 2] = h[p + 2] + pz;
      positions[vert + 3] = h[p] - px;
      positions[vert + 4] = h[p + 1];
      positions[vert + 5] = h[p + 2] - pz;
      const fade = (1 - k / (SAMPLES - 1)) ** 1.6 * 0.65;
      for (let s = 0; s < 2; s++) {
        colors[vert + s * 3] = r * fade;
        colors[vert + s * 3 + 1] = g * fade;
        colors[vert + s * 3 + 2] = b * fade;
      }
    }
  }
  // Vehicles that have left the road take their trails with them.
  if (histories.size > seen.size) for (const id of histories.keys()) if (!seen.has(id)) histories.delete(id);
  geometry.setDrawRange(0, n * (SAMPLES - 1) * 6);
  // Only the ribbons in use go to the GPU, not the whole worst-case buffer.
  for (const attr of [geometry.getAttribute("position") as THREE.BufferAttribute, geometry.getAttribute("color") as THREE.BufferAttribute]) {
    attr.clearUpdateRanges();
    if (n > 0) attr.addUpdateRange(0, n * SAMPLES * 6);
    attr.needsUpdate = true;
  }
}

/**
 * The long-exposure look: every vehicle drags a ribbon of light behind it that fades over a few hundred feet,
 * warm white while it cruises and red while it brakes. Only mounted during the flyover. Positions come straight out
 * of the instance matrices the renderer already gets, so nothing extra is asked of the simulation.
 */
function LightTrails({ snapshotRef }: { snapshotRef: RefObject<VehicleSnapshot | null> }) {
  const clock = useRef(0);
  const shed = useDetailShed();
  const camera = useThree((s) => s.camera);

  const { geometry, buffers } = useMemo(() => {
    const vertCount = MAX_VEHICLES * SAMPLES * 2;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const indices = new Uint32Array(MAX_VEHICLES * (SAMPLES - 1) * 6);
    let w = 0;
    for (let v = 0; v < MAX_VEHICLES; v++) {
      for (let k = 0; k < SAMPLES - 1; k++) {
        const a = (v * SAMPLES + k) * 2;
        indices[w++] = a;
        indices[w++] = a + 1;
        indices[w++] = a + 2;
        indices[w++] = a + 1;
        indices[w++] = a + 3;
        indices[w++] = a + 2;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    const buffers: TrailBuffers = { geometry, positions, colors, histories: new Map() };
    return { geometry, buffers };
  }, []);

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((_, delta) => {
    clock.current += delta;
    // Under load the ribbons are refreshed less often (and not at all when the frame rate is really struggling).
    if (shed >= 2 || clock.current < SAMPLE_EVERY_S * (shed === 1 ? 2.5 : 1)) return;
    clock.current = 0;
    const snap = snapshotRef.current;
    // Ribbons widen as the camera pulls back, so they still read in a wide shot.
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1;
    if (snap) sampleTrails(buffers, snap, Math.min(4.5, Math.max(1.4, 2 / zoom)));
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={6} />;
}

export default memo(LightTrails);
