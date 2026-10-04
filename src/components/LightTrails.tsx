"use client";

import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { MAX_VEHICLES } from "@/sim/types";

/** Samples kept per vehicle, newest first. */
const SAMPLES = 30;
/** Real seconds between samples. */
const SAMPLE_EVERY_S = 0.1;
const HEIGHT_FT = 1.4;
/** A slot that moves farther than this between samples is a different vehicle, so its trail starts over. */
const JUMP_FT = 70;
/** A taillight at least this bright counts as braking. */
const BRAKE_LEVEL = 0.95;

interface TrailBuffers {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  colors: Float32Array;
  history: Float32Array;
  lastCount: number;
}

/** Adds one sample of every vehicle's position to its ribbon and rewrites the ribbon's vertices. */
function sampleTrails(t: TrailBuffers, snap: VehicleSnapshot, halfWidth: number): void {
  const { positions, colors, geometry } = t;
  const n = Math.min(snap.activeCount, MAX_VEHICLES);
  const h = t.history;
  const m = snap.matrices;
  const tl = snap.taillightColors;
    for (let v = 0; v < n; v++) {
    const base = v * SAMPLES * 3;
    const x = m[v * 16 + 12];
    const y = m[v * 16 + 13] + HEIGHT_FT;
    const z = m[v * 16 + 14];
    // A slot is reused when vehicles come and go, so a new head that is far from, or off the line of, the old trail is a different vehicle.
    let fresh = v >= t.lastCount;
    if (!fresh) {
      const mx = x - h[base];
      const mz = z - h[base + 2];
      const moved = Math.hypot(mx, mz);
      const px = h[base] - h[base + 3];
      const pz = h[base + 2] - h[base + 5];
      const prev = Math.hypot(px, pz);
      fresh = moved > JUMP_FT || (moved > 3 && prev > 3 && (mx * px + mz * pz) / (moved * prev) < 0.6);
    }
    if (fresh) {
      for (let k = 0; k < SAMPLES; k++) {
        h[base + k * 3] = x;
        h[base + k * 3 + 1] = y;
        h[base + k * 3 + 2] = z;
      }
    } else {
      h.copyWithin(base + 3, base, base + (SAMPLES - 1) * 3);
      h[base] = x;
      h[base + 1] = y;
      h[base + 2] = z;
    }

    const braking = tl[v * 3] > BRAKE_LEVEL;
    const r = 1;
    const g = braking ? 0.1 : 0.78;
    const b = braking ? 0.06 : 0.42;
    for (let k = 0; k < SAMPLES; k++) {
      const p = base + k * 3;
      const q = base + Math.min(k + 1, SAMPLES - 1) * 3;
      const p0 = base + Math.max(k - 1, 0) * 3;
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
  t.lastCount = n;
  geometry.setDrawRange(0, n * (SAMPLES - 1) * 6);
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.color.needsUpdate = true;
}

/**
 * The long-exposure look: every vehicle drags a ribbon of light behind it that fades over a few hundred feet,
 * warm white while it cruises and red while it brakes. Only mounted during the flyover. Positions come straight out
 * of the instance matrices the renderer already gets, so nothing extra is asked of the simulation.
 */
function LightTrails({ snapshotRef }: { snapshotRef: RefObject<VehicleSnapshot | null> }) {
  const clock = useRef(0);
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
    const buffers: TrailBuffers = { geometry, positions, colors, history: new Float32Array(MAX_VEHICLES * SAMPLES * 3), lastCount: 0 };
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
    if (clock.current < SAMPLE_EVERY_S) return;
    clock.current = 0;
    const snap = snapshotRef.current;
    // Ribbons widen as the camera pulls back, so they still read in a wide shot.
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1;
    if (snap) sampleTrails(buffers, snap, Math.min(4.5, Math.max(1.4, 2 / zoom)));
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={6} />;
}

export default memo(LightTrails);
