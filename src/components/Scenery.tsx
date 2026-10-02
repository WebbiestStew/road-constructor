"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useEditorStore } from "@/state/editorStore";
import { useGraphics } from "@/lib/quality";
import type { SceneryData } from "@/sim/osm/scenery";

function hash01(i: number, salt: number): number {
  let h = (i + 1) * 374761393 + salt * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A wall colour from a height: low buildings are warm and pale, towers cool and glassy, each with its own small variation. */
function wallColor(heightFt: number, i: number): [number, number, number] {
  const tall = Math.min(1, heightFt / 320);
  const v = 0.78 + hash01(i, 1) * 0.16;
  const warm: [number, number, number] = [0.93, 0.87, 0.78];
  const cool: [number, number, number] = [0.66, 0.74, 0.84];
  return [
    (warm[0] + (cool[0] - warm[0]) * tall) * v,
    (warm[1] + (cool[1] - warm[1]) * tall) * v,
    (warm[2] + (cool[2] - warm[2]) * tall) * v,
  ];
}

function buildBuildings(data: SceneryData): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  data.buildings.forEach((b, i) => {
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k + 1 < b.p.length; k += 2) pts.push(new THREE.Vector2(b.p[k], -b.p[k + 1]));
    if (pts.length < 3) return;
    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
    let g: THREE.BufferGeometry;
    try {
      g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: b.h, bevelEnabled: false });
    } catch {
      return;
    }
    // Shape lies in XY and extrudes along +Z; stand it up so extrusion is height and the shape is the footprint.
    g.rotateX(-Math.PI / 2);
    const normal = g.getAttribute("normal");
    const colors = new Float32Array(normal.count * 3);
    const [r, gr, bl] = wallColor(b.h, i);
    for (let v = 0; v < normal.count; v++) {
      const roof = normal.getY(v) > 0.6;
      const k = roof ? 1.12 : 1;
      colors[v * 3] = Math.min(1, r * k);
      colors[v * 3 + 1] = Math.min(1, gr * k);
      colors[v * 3 + 2] = Math.min(1, bl * k);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  });
  return parts.length ? mergeGeometries(parts, false) : null;
}

function buildWater(data: SceneryData): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const poly of data.water) {
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k + 1 < poly.length; k += 2) pts.push(new THREE.Vector2(poly[k], -poly[k + 1]));
    if (pts.length < 3) continue;
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts));
    g.rotateX(-Math.PI / 2);
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  return parts.length ? mergeGeometries(parts, false) : null;
}

interface UrbanGround {
  x: number;
  z: number;
  w: number;
  d: number;
}

/**
 * Dense cities get a paved ground under them instead of meadow showing between the blocks. Returns the rectangle
 * covering the buildings, or null when the area is too sparse (a freeway interchange in open country keeps its grass).
 */
function urbanGround(data: SceneryData): UrbanGround | null {
  if (data.buildings.length < 150) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, covered = 0;
  for (const b of data.buildings) {
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (let k = 0; k + 1 < b.p.length; k += 2) {
      bx0 = Math.min(bx0, b.p[k]); bx1 = Math.max(bx1, b.p[k]);
      bz0 = Math.min(bz0, b.p[k + 1]); bz1 = Math.max(bz1, b.p[k + 1]);
    }
    minX = Math.min(minX, bx0); maxX = Math.max(maxX, bx1);
    minZ = Math.min(minZ, bz0); maxZ = Math.max(maxZ, bz1);
    covered += (bx1 - bx0) * (bz1 - bz0);
  }
  const pad = 60;
  const w = maxX - minX + pad * 2;
  const d = maxZ - minZ + pad * 2;
  if (covered / (w * d) < 0.3) return null;
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, w, d };
}

/**
 * The buildings and water around a real city's roads: real footprints from OpenStreetMap extruded to their real (or
 * estimated) height, as one merged mesh. Skipped entirely when 'Buildings and scenery' is off.
 */
function Scenery() {
  const scenery = useEditorStore((s) => s.scenery);
  const on = useGraphics().setDressing;
  const buildings = useMemo(() => (on ? buildBuildings(scenery) : null), [scenery, on]);
  const water = useMemo(() => (on ? buildWater(scenery) : null), [scenery, on]);
  const ground = useMemo(() => (on ? urbanGround(scenery) : null), [scenery, on]);
  if (!on) return null;
  return (
    <>
      {ground && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ground.x, -0.2, ground.z]} receiveShadow>
          <planeGeometry args={[ground.w, ground.d]} />
          <meshStandardMaterial color="#a9aca3" roughness={0.95} />
        </mesh>
      )}
      {buildings && (
        <mesh geometry={buildings} castShadow receiveShadow frustumCulled={false}>
          <meshStandardMaterial vertexColors roughness={0.85} metalness={0.05} />
        </mesh>
      )}
      {water && (
        <mesh geometry={water} position={[0, -0.1, 0]} renderOrder={-1} frustumCulled={false}>
          <meshStandardMaterial color="#5aa9dc" roughness={0.25} metalness={0.2} />
        </mesh>
      )}
    </>
  );
}

export default memo(Scenery);
