"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  MAX_VEHICLES,
  VEHICLE_HEIGHT_FT,
  VEHICLE_LENGTH_FT,
  VEHICLE_WIDTH_FT,
} from "@/sim/types";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";

interface VehicleRendererProps {
  snapshotRef: RefObject<VehicleSnapshot | null>;
}

/**
 * Renders up to MAX_VEHICLES vehicles via a single THREE.InstancedMesh.
 * Every worker tick hands us a fresh, fully-populated Float32Array pair
 * (transferable ArrayBuffers, already turned into typed-array views by the
 * hook). Rather than copying that data into a persistent buffer, we swap
 * the InstancedMesh's own attribute `.array` reference directly to the
 * incoming typed array each frame — a true zero-copy hand-off from worker
 * memory straight to the GPU upload, with no per-frame allocation on the
 * render thread.
 */
export default function VehicleRenderer({ snapshotRef }: VehicleRendererProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const headlightRef = useRef<THREE.InstancedMesh>(null);
  const taillightRef = useRef<THREE.InstancedMesh>(null);
  const shadowRef = useRef<THREE.InstancedMesh>(null);
  const lastVersionRef = useRef(0);
  const lightsOn = useEditorStore((s) => s.timeOfDay !== "day");

  // A thin emissive bar embedded at the front face of the vehicle's own
  // local box space (not the origin) — since it shares the vehicle's exact
  // instance matrix below, this bakes correctly to each vehicle's front
  // bumper in world space with zero per-instance math.
  const headlightGeometry = useMemo(() => {
    const geo = new THREE.BoxGeometry(VEHICLE_WIDTH_FT * 0.82, VEHICLE_HEIGHT_FT * 0.22, 0.6);
    geo.translate(0, -VEHICLE_HEIGHT_FT * 0.12, VEHICLE_LENGTH_FT / 2 - 0.2);
    return geo;
  }, []);

  // Same trick, mirrored to the rear face, for glowing red taillights.
  const taillightGeometry = useMemo(() => {
    const geo = new THREE.BoxGeometry(VEHICLE_WIDTH_FT * 0.82, VEHICLE_HEIGHT_FT * 0.22, 0.5);
    geo.translate(0, -VEHICLE_HEIGHT_FT * 0.12, -(VEHICLE_LENGTH_FT / 2 - 0.15));
    return geo;
  }, []);

  // A flat dark quad sitting right at ground level under the vehicle's own
  // local box space — since it shares the vehicle's instance matrix, it
  // rides along under each vehicle as a cheap contact-shadow stand-in with
  // zero per-instance math, the same trick as the head/taillight geometry.
  const shadowGeometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(VEHICLE_WIDTH_FT * 1.3, VEHICLE_LENGTH_FT * 1.15);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -VEHICLE_HEIGHT_FT / 2 + 0.05, 0);
    return geo;
  }, []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_VEHICLES * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
  }, []);

  useEffect(() => {
    const headlights = headlightRef.current;
    if (!headlights) return;
    headlights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    headlights.count = 0;
    headlights.frustumCulled = false;
  }, []);

  useEffect(() => {
    const taillights = taillightRef.current;
    if (!taillights) return;
    taillights.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_VEHICLES * 3), 3);
    taillights.instanceColor.setUsage(THREE.DynamicDrawUsage);
    taillights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    taillights.count = 0;
    taillights.frustumCulled = false;
  }, []);

  useEffect(() => {
    const shadows = shadowRef.current;
    if (!shadows) return;
    shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shadows.count = 0;
    shadows.frustumCulled = false;
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    const snapshot = snapshotRef.current;
    if (!mesh || !snapshot || !mesh.instanceColor) return;
    if (snapshot.version === lastVersionRef.current) return;
    lastVersionRef.current = snapshot.version;

    mesh.instanceMatrix.array = snapshot.matrices;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.array = snapshot.colors;
    mesh.instanceColor.needsUpdate = true;
    mesh.count = snapshot.activeCount;

    const headlights = headlightRef.current;
    if (lightsOn && headlights) {
      headlights.instanceMatrix.array = snapshot.matrices;
      headlights.instanceMatrix.needsUpdate = true;
      headlights.count = snapshot.activeCount;
    } else if (headlights) {
      headlights.count = 0;
    }

    // Taillights stay on at all times of day (real brake lights work in
    // daylight too) — only their per-instance color changes, from a dim
    // cruising glow to a brightened brake flash, via instanceColor written
    // by the worker from each vehicle's IDM acceleration.
    const taillights = taillightRef.current;
    if (taillights && taillights.instanceColor) {
      taillights.instanceMatrix.array = snapshot.matrices;
      taillights.instanceMatrix.needsUpdate = true;
      taillights.instanceColor.array = snapshot.taillightColors;
      taillights.instanceColor.needsUpdate = true;
      taillights.count = snapshot.activeCount;
    }

    const shadows = shadowRef.current;
    if (shadows) {
      shadows.instanceMatrix.array = snapshot.matrices;
      shadows.instanceMatrix.needsUpdate = true;
      shadows.count = snapshot.activeCount;
    }
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, MAX_VEHICLES]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[VEHICLE_WIDTH_FT, VEHICLE_HEIGHT_FT, VEHICLE_LENGTH_FT]} />
        <meshStandardMaterial color="#ffffff" roughness={0.45} metalness={0.35} />
      </instancedMesh>
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
