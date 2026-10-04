"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { assembleCached } from "@/sim/assembleCache";
import { fastPointAt, fastTangentAt } from "@/sim/laneGeometry";
import type { Edge3D } from "@/sim/types";
import { useEditorStore } from "@/state/editorStore";
import { usePhotoMode } from "@/lib/photoMode";

/**
 * Street names painted on the pavement, along the road, like the labels on a map. Every name is drawn once into one
 * shared atlas texture and every label is a quad in one mesh, so hundreds of names cost a single draw call. They fade
 * in as the camera comes close enough to read them.
 */

const ATLAS = 2048;
const CELL_W = 384;
const CELL_H = 40;
const FONT_PX = 28;
/** Feet of road per atlas pixel: sets how big the lettering is on the ground. */
const FT_PER_PX = 0.85;
const MAX_LABELS = Math.floor(ATLAS / CELL_W) * Math.floor(ATLAS / CELL_H);
/** Two labels with the same name closer than this (ft) are the same road, so only one is drawn. */
const SAME_ROAD_FT = 420;
const MIN_EDGE_FT = 120;
/** The camera zoom at which labels start to appear and at which they are fully shown. */
const FADE_IN_ZOOM = 0.3;
const FULL_ZOOM = 0.6;

interface Label {
  name: string;
  x: number;
  y: number;
  z: number;
  /** Unit direction of the text along the ground, flipped so it reads left to right (or bottom to top on a vertical road). */
  ux: number;
  uz: number;
  rank: number;
}

const CLASS_RANK: Record<string, number> = { motorway: 5, highway: 4, avenue: 3, street: 2, lane: 1 };

/** One label per named road, at the middle of its longest piece, most important roads first. */
function pickLabels(edges: Edge3D[]): Label[] {
  const named = edges.filter((e) => e.name && !e.ramp && !e.isRoundaboutRing && e.length >= MIN_EDGE_FT);
  named.sort((a, b) => (CLASS_RANK[b.roadClassId] ?? 0) - (CLASS_RANK[a.roadClassId] ?? 0) || b.length - a.length);
  const placed: Label[] = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (const e of named) {
    if (placed.length >= MAX_LABELS) break;
    // A name too long for its stretch of road would run into the junctions at either end.
    if (e.name!.length * FONT_PX * 0.66 * FT_PER_PX > e.length * 0.92) continue;
    fastPointAt(e, 0.5, p);
    if (p.y < -5) continue; // tunnels and deep cuttings are underground
    if (placed.some((l) => l.name === e.name && Math.hypot(l.x - p.x, l.z - p.z) < SAME_ROAD_FT)) continue;
    fastTangentAt(e, 0.5, t);
    let ux = t.x;
    let uz = t.z;
    const len = Math.hypot(ux, uz) || 1;
    ux /= len;
    uz /= len;
    // Read left to right on a road that runs mostly east-west, bottom to top on one that runs mostly north-south.
    if (Math.abs(ux) >= Math.abs(uz) ? ux < 0 : uz > 0) {
      ux = -ux;
      uz = -uz;
    }
    placed.push({ name: e.name!, x: p.x, y: p.y + 0.5, z: p.z, ux, uz, rank: CLASS_RANK[e.roadClassId] ?? 0 });
  }
  return placed;
}

function buildMesh(labels: Label[]): { geometry: THREE.BufferGeometry; texture: THREE.CanvasTexture } | null {
  if (labels.length === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ATLAS;
  const g = canvas.getContext("2d")!;
  g.textBaseline = "middle";
  g.textAlign = "center";
  g.lineJoin = "round";
  const cols = Math.floor(ATLAS / CELL_W);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  labels.forEach((l, i) => {
    const cx = (i % cols) * CELL_W;
    const cy = Math.floor(i / cols) * CELL_H;
    let px = FONT_PX;
    g.font = `800 ${px}px system-ui, sans-serif`;
    let w = g.measureText(l.name.toUpperCase()).width;
    if (w > CELL_W - 16) {
      px = Math.floor((px * (CELL_W - 16)) / w);
      g.font = `800 ${px}px system-ui, sans-serif`;
      w = g.measureText(l.name.toUpperCase()).width;
    }
    const mx = cx + CELL_W / 2;
    const my = cy + CELL_H / 2;
    g.lineWidth = 6;
    g.strokeStyle = "rgba(20,24,36,0.85)";
    g.strokeText(l.name.toUpperCase(), mx, my);
    g.fillStyle = "#f6f3e8";
    g.fillText(l.name.toUpperCase(), mx, my);

    // The quad covers just the text, not the whole cell.
    const halfPx = Math.ceil(w / 2) + 6;
    const halfL = halfPx * FT_PER_PX;
    const halfH = (CELL_H / 2) * FT_PER_PX;
    const upx = l.uz;
    const upz = -l.ux;
    const base = positions.length / 3;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      positions.push(l.x + l.ux * halfL * sx + upx * halfH * sy, l.y, l.z + l.uz * halfL * sx + upz * halfH * sy);
      uvs.push((mx + sx * halfPx) / ATLAS, 1 - (my - sy * (CELL_H / 2)) / ATLAS);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { geometry, texture };
}

function StreetNames() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const photo = usePhotoMode();
  const network = useMemo(() => assembleCached(nodes, edges), [nodes, edges]);
  const built = useMemo(() => buildMesh(pickLabels(network.edges)), [network]);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const mesh = useRef<THREE.Mesh>(null);

  useEffect(
    () => () => {
      built?.geometry.dispose();
      built?.texture.dispose();
    },
    [built],
  );

  useFrame(({ camera }) => {
    const m = material.current;
    const o = mesh.current;
    if (!m || !o) return;
    const zoom = (camera as THREE.OrthographicCamera).zoom ?? 1;
    const k = Math.min(1, Math.max(0, (zoom - FADE_IN_ZOOM) / (FULL_ZOOM - FADE_IN_ZOOM)));
    m.opacity = k * 0.92;
    o.visible = k > 0.02 && !photo;
  });

  if (!built) return null;
  return (
    <mesh ref={mesh} geometry={built.geometry} renderOrder={5} frustumCulled={false} visible={false}>
      <meshBasicMaterial
        ref={material}
        map={built.texture}
        transparent
        opacity={0}
        depthWrite={false}
        toneMapped={false}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={-4}
        polygonOffsetUnits={-4}
      />
    </mesh>
  );
}

export default memo(StreetNames);
