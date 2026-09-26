"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

const GROUND_SIZE = 24000;
const TREE_COUNT = 650;
const TREE_FIELD_RADIUS = 5200;
const TREE_CLEAR_RADIUS = 55;

const TREE_COLORS = ["#4d6b3a", "#5a7a42", "#3f5a30", "#65814a"];

/**
 * Procedurally generates a tileable "farmland" ground texture — mottled
 * khaki base, faint darker/lighter patches, small dirt/wildflower
 * speckles, and subtle plow-line diagonals — entirely from a 2D canvas, no
 * external art assets.
 */
function createGroundTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#c7bd8f";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 240; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 8 + Math.random() * 28;
    ctx.fillStyle = Math.random() < 0.5 ? "rgba(120,110,70,0.14)" : "rgba(188,180,138,0.16)";
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.55, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < 550; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = Math.random() < 0.4 ? "rgba(196,92,60,0.55)" : "rgba(96,86,52,0.4)";
    ctx.fillRect(x, y, 1.4, 1.4);
  }

  ctx.strokeStyle = "rgba(90,80,50,0.09)";
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
    trees.push({
      position: [Math.cos(angle) * radius, 0, Math.sin(angle) * radius],
      scale: 7 + Math.random() * 9,
      rotationY: Math.random() * Math.PI * 2,
      color: TREE_COLORS[Math.floor(Math.random() * TREE_COLORS.length)],
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
