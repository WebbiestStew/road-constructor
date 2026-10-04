"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { assembleCached } from "@/sim/assembleCache";
import { hasGantry } from "@/sim/network";
import { fastTangentAt, laneCenterPointAt } from "@/sim/laneGeometry";
import type { Edge3D } from "@/sim/types";
import { MANAGER_TOOLS, useEditorStore } from "@/state/editorStore";

/** Overhead gantries on freeways (speed advisories and lane signals) and the road markings of continuous-flow left turns. */

const BEAM_HEIGHT_FT = 21;
const SIGN_FT = 6.5;
const DISPLACED_ZONE_FT = 320;

const signTextures = new Map<string, THREE.CanvasTexture>();

function signTexture(kind: "x" | "arrow" | "limit", value = 0): THREE.CanvasTexture {
  const key = `${kind}:${value}`;
  const cached = signTextures.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#0b0d12";
  g.fillRect(0, 0, 128, 128);
  g.lineCap = "round";
  g.lineJoin = "round";
  if (kind === "x") {
    g.strokeStyle = "#ff2d2d";
    g.lineWidth = 16;
    g.beginPath();
    g.moveTo(30, 30);
    g.lineTo(98, 98);
    g.moveTo(98, 30);
    g.lineTo(30, 98);
    g.stroke();
  } else if (kind === "arrow") {
    g.strokeStyle = "#2dff7a";
    g.lineWidth = 15;
    g.beginPath();
    g.moveTo(64, 20);
    g.lineTo(64, 104);
    g.moveTo(30, 70);
    g.lineTo(64, 106);
    g.lineTo(98, 70);
    g.stroke();
  } else {
    g.fillStyle = "#fff6e0";
    g.beginPath();
    g.arc(64, 64, 52, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#ffb020";
    g.lineWidth = 9;
    g.stroke();
    g.fillStyle = "#14161c";
    g.font = "bold 58px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(value), 64, 68);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  signTextures.set(key, tex);
  return tex;
}

const steelMaterial = new THREE.MeshStandardMaterial({ color: "#8d949e", roughness: 0.6, metalness: 0.5 });
const legGeometry = new THREE.BoxGeometry(1.6, BEAM_HEIGHT_FT, 1.6);
const housingGeometry = new THREE.BoxGeometry(SIGN_FT + 0.8, SIGN_FT + 0.8, 0.8);
const housingMaterial = new THREE.MeshStandardMaterial({ color: "#1c1f26", roughness: 0.8 });
const signGeometry = new THREE.PlaneGeometry(SIGN_FT, SIGN_FT);

interface GantryPlacement {
  edge: Edge3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Lane signs' lateral offsets along the beam, left lane first. */
  laneOffsets: number[];
  halfSpan: number;
}

function placeGantry(edge: Edge3D): GantryPlacement {
  const t = 0.5;
  const tan = new THREE.Vector3();
  const right = new THREE.Vector3();
  const first = new THREE.Vector3();
  const last = new THREE.Vector3();
  const scratchT = new THREE.Vector3();
  laneCenterPointAt(edge, t, 0, scratchT, right, first);
  laneCenterPointAt(edge, t, edge.lanes - 1, scratchT, right, last);
  fastTangentAt(edge, t, tan);
  const lateral = last.clone().sub(first);
  lateral.y = 0;
  const along = lateral.length() > 0.01 ? lateral.clone().normalize() : right.clone();
  const mid = first.clone().add(last).multiplyScalar(0.5);
  const up = new THREE.Vector3(0, 1, 0);
  // z faces back toward oncoming drivers, x runs from the left lane to the right lane.
  const z = tan.clone().multiplyScalar(-1);
  z.y = 0;
  z.normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  if (x.dot(along) < 0) x.multiplyScalar(-1);
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  const laneOffsets: number[] = [];
  for (let i = 0; i < edge.lanes; i++) {
    const p = new THREE.Vector3();
    laneCenterPointAt(edge, t, i, scratchT, right, p);
    laneOffsets.push(p.sub(mid).dot(x));
  }
  return { edge, position: mid, quaternion, laneOffsets, halfSpan: (edge.lanes * edge.laneWidthFt) / 2 + 3.5 };
}

function Gantry({ placement }: { placement: GantryPlacement }) {
  const { edge } = placement;
  const spec = useEditorStore((s) => s.edgesById.get(edge.id));
  const selected = useEditorStore((s) => s.selection?.kind === "edge" && s.selection.id === edge.id);
  const closed = new Set(spec?.closedLanes ?? []);
  const advisory = spec?.vslMph ?? 0;

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    const store = useEditorStore.getState();
    if (!MANAGER_TOOLS.includes(store.tool)) return;
    event.stopPropagation();
    if (store.tool !== "gantry") store.setTool("gantry");
    store.setSelection({ kind: "edge", id: edge.id });
  };

  const beamMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#8d949e", roughness: 0.6, metalness: 0.5, emissive: "#000000" }),
    [],
  );
  beamMaterial.emissive.set(selected ? "#7a5200" : "#000000");

  return (
    <group position={placement.position} quaternion={placement.quaternion} onClick={onClick}>
      <mesh geometry={legGeometry} material={steelMaterial} position={[-placement.halfSpan, BEAM_HEIGHT_FT / 2, 0]} />
      <mesh geometry={legGeometry} material={steelMaterial} position={[placement.halfSpan, BEAM_HEIGHT_FT / 2, 0]} />
      <mesh material={beamMaterial} position={[0, BEAM_HEIGHT_FT + 0.4, 0]} scale={[placement.halfSpan * 2 + 1.6, 1.6, 1.8]}>
        <boxGeometry args={[1, 1, 1]} />
      </mesh>
      {placement.laneOffsets.map((off, lane) => {
        const isClosed = closed.has(lane);
        const tex = isClosed ? signTexture("x") : advisory ? signTexture("limit", advisory) : signTexture("arrow");
        return (
          <group key={lane} position={[off, BEAM_HEIGHT_FT - SIGN_FT / 2 - 0.6, 0.5]}>
            <mesh geometry={housingGeometry} material={housingMaterial} position={[0, 0, -0.5]} />
            <mesh geometry={signGeometry}>
              <meshBasicMaterial map={tex} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

const barMaterial = new THREE.MeshBasicMaterial({ color: "#ff3b30", toneMapped: false });
const laneMaterial = new THREE.MeshBasicMaterial({ color: "#ffb020", transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });

/** A tinted strip down the displaced left lane, with a red bar where its small signal stops cars before the crossover. */
function DisplacedLeft({ edge }: { edge: Edge3D }) {
  const parts = useMemo(() => {
    const fromD = Math.max(20, edge.length - DISPLACED_ZONE_FT);
    const toD = edge.length - 26;
    if (toD <= fromD) return null;
    const steps = Math.max(2, Math.ceil((toD - fromD) / 16));
    const positions: number[] = [];
    const indices: number[] = [];
    const p = new THREE.Vector3();
    const right = new THREE.Vector3();
    const scratch = new THREE.Vector3();
    const half = edge.laneWidthFt * 0.46;
    for (let i = 0; i <= steps; i++) {
      const d = fromD + ((toD - fromD) * i) / steps;
      laneCenterPointAt(edge, d / edge.length, 0, scratch, right, p);
      positions.push(p.x - right.x * half, p.y + 0.22, p.z - right.z * half, p.x + right.x * half, p.y + 0.22, p.z + right.z * half);
      if (i < steps) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    // The pre-signal bar across the lane at the start of the zone.
    laneCenterPointAt(edge, fromD / edge.length, 0, scratch, right, p);
    const angle = Math.atan2(-right.z, right.x);
    return { geometry, bar: p.clone(), angle, width: edge.laneWidthFt * 0.95 };
  }, [edge]);
  if (!parts) return null;
  return (
    <group>
      <mesh geometry={parts.geometry} material={laneMaterial} renderOrder={3} />
      <mesh material={barMaterial} position={[parts.bar.x, parts.bar.y + 0.3, parts.bar.z]} rotation={[0, parts.angle, 0]} renderOrder={4}>
        <boxGeometry args={[parts.width, 0.25, 1.4]} />
      </mesh>
      <mesh material={barMaterial} position={[parts.bar.x, parts.bar.y + 3.2, parts.bar.z]}>
        <boxGeometry args={[1, 5.4, 1]} />
      </mesh>
    </group>
  );
}

function ManagementOverlays() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const network = useMemo(() => assembleCached(nodes, edges), [nodes, edges]);
  const gantries = useMemo(() => network.edges.filter(hasGantry).map(placeGantry), [network]);
  const displaced = useMemo(() => network.edges.filter((e) => e.displacedLeft), [network]);

  return (
    <group>
      {gantries.map((g) => (
        <Gantry key={g.edge.id} placement={g} />
      ))}
      {displaced.map((e) => (
        <DisplacedLeft key={e.id} edge={e} />
      ))}
    </group>
  );
}

export default memo(ManagementOverlays);
