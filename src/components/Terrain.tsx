"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

const GROUND_SIZE = 24000;
const TREE_COUNT = 650;
const TREE_FIELD_RADIUS = 5200;
const TREE_CLEAR_RADIUS = 55;

const TREE_COLORS = ["#4ade80", "#22c55e", "#16a34a", "#65d979", "#34d399"];
const BLOSSOM_COLORS = ["#fda4d5", "#f9a8d4", "#fecdd3"];

/**
 * Procedurally generates a tileable meadow ground texture — vivid green
 * base, mottled patches, colorful wildflower speckles, and subtle
 * plow-line diagonals — entirely from a 2D canvas, no external art assets.
 */
function createGroundTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#8fd66b";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 240; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 8 + Math.random() * 28;
    ctx.fillStyle = Math.random() < 0.5 ? "rgba(70,150,60,0.16)" : "rgba(190,230,120,0.22)";
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.55, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  const flowerColors = [
    "rgba(255,138,200,0.75)",
    "rgba(255,214,90,0.8)",
    "rgba(147,197,253,0.7)",
    "rgba(255,255,255,0.65)",
  ];
  for (let i = 0; i < 620; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = flowerColors[Math.floor(Math.random() * flowerColors.length)];
    ctx.fillRect(x, y, 2, 2);
  }

  ctx.strokeStyle = "rgba(40,110,40,0.08)";
  ctx.lineWidth = 1;
  for (let i = -size; i < size * 2; i += 26) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i - size, size);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(36, 36);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface TreeInstance {
  position: [number, number, number];
  scale: number;
  rotationY: number;
  color: string;
}

function generateTrees(): TreeInstance[] {
  const trees: TreeInstance[] = [];
  for (let i = 0; i < TREE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = TREE_CLEAR_RADIUS + Math.sqrt(Math.random()) * (TREE_FIELD_RADIUS - TREE_CLEAR_RADIUS);
    const isBlossom = Math.random() < 0.08;
    const palette = isBlossom ? BLOSSOM_COLORS : TREE_COLORS;
    trees.push({
      position: [Math.cos(angle) * radius, 0, Math.sin(angle) * radius],
      scale: 7 + Math.random() * 9,
      rotationY: Math.random() * Math.PI * 2,
      color: palette[Math.floor(Math.random() * palette.length)],
    });
  }
  return trees;
}

function TreeInstancedGroup({ color, instances }: { color: string; instances: TreeInstance[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scaleVec = new THREE.Vector3();
    instances.forEach((t, i) => {
      euler.set(0, t.rotationY, 0);
      quat.setFromEuler(euler);
      pos.set(t.position[0], t.scale * 0.4, t.position[2]);
      scaleVec.set(t.scale, t.scale * 0.4, t.scale);
      matrix.compose(pos, quat, scaleVec);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [instances]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, instances.length]} castShadow receiveShadow>
      <icosahedronGeometry args={[1, 0]} />
      <meshStandardMaterial color={color} roughness={1} />
    </instancedMesh>
  );
}

function TreeField() {
  const trees = useMemo(() => generateTrees(), []);
  const grouped = useMemo(() => {
    const byColor = new Map<string, TreeInstance[]>();
    for (const t of trees) {
      const arr = byColor.get(t.color) ?? [];
      arr.push(t);
      byColor.set(t.color, arr);
    }
    return byColor;
  }, [trees]);

  return (
    <group>
      {Array.from(grouped.entries()).map(([color, instances]) => (
        <TreeInstancedGroup key={color} color={color} instances={instances} />
      ))}
    </group>
  );
}

export default function Terrain() {
  const texture = useMemo(() => createGroundTexture(), []);

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.3, 0]} receiveShadow>
        <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
        <meshStandardMaterial map={texture} roughness={1} metalness={0} />
      </mesh>
      <TreeField />
    </group>
  );
}
