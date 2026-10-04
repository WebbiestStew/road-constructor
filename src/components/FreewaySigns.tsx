"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { assembleCached } from "@/sim/assembleCache";
import { fastTangentAt, laneCenterPointAt } from "@/sim/laneGeometry";
import type { Edge3D } from "@/sim/types";
import { useEditorStore } from "@/state/editorStore";

/** Green guide signs beside freeways: an advance warning and an EXIT sign before each ramp, and a route shield where a freeway begins. */

const textures = new Map<string, THREE.CanvasTexture>();

function signTexture(key: string, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 256, h = 128): THREE.CanvasTexture {
  const cached = textures.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  textures.set(key, tex);
  return tex;
}

function guideSign(g: CanvasRenderingContext2D, w: number, h: number, top: string, big: string, small?: string) {
  g.fillStyle = "#0b6b3a";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#ffffff";
  g.lineWidth = 6;
  g.strokeRect(7, 7, w - 14, h - 14);
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "bold 28px system-ui, sans-serif";
  g.fillText(top, w / 2, 32);
  g.font = "bold 58px system-ui, sans-serif";
  g.fillText(big, w / 2, small ? 74 : 84);
  if (small) {
    g.font = "bold 24px system-ui, sans-serif";
    g.fillText(small, w / 2, 110);
  }
}

function shieldTexture(n: number): THREE.CanvasTexture {
  return signTexture(`shield:${n}`, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const cx = w / 2;
    g.beginPath();
    g.moveTo(cx - 54, 22);
    g.quadraticCurveTo(cx, 6, cx + 54, 22);
    g.lineTo(cx + 54, 70);
    g.quadraticCurveTo(cx + 40, 112, cx, 122);
    g.quadraticCurveTo(cx - 40, 112, cx - 54, 70);
    g.closePath();
    g.fillStyle = "#1d4fa8";
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = "#ffffff";
    g.stroke();
    g.fillStyle = "#d62828";
    g.fillRect(cx - 48, 24, 96, 20);
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "bold 46px system-ui, sans-serif";
    g.fillText(String(n), cx, 78);
  }, 256, 128);
}

interface Placement {
  key: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  texture: THREE.CanvasTexture;
  width: number;
  height: number;
  elevatedY: number;
}

const up = new THREE.Vector3(0, 1, 0);

function place(edge: Edge3D, distanceFt: number, texture: THREE.CanvasTexture, key: string, shield = false): Placement {
  const t = Math.min(0.97, Math.max(0.03, distanceFt / edge.length));
  const tan = new THREE.Vector3();
  const right = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const lane = new THREE.Vector3();
  laneCenterPointAt(edge, t, edge.lanes - 1, scratch, right, lane);
  fastTangentAt(edge, t, tan);
  // On the right shoulder, a lane and a half out from the outside lane's centre.
  const position = lane.clone().addScaledVector(right, edge.laneWidthFt * 1.9 + 4);
  const z = tan.clone().multiplyScalar(-1);
  z.y = 0;
  z.normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  return { key, position, quaternion, texture, width: shield ? 8 : 15, height: shield ? 8 : 7.5, elevatedY: 0 };
}

function buildSigns(edges: Edge3D[]): Placement[] {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const out: Placement[] = [];
  let exitNumber = 0;
  for (const e of edges) {
    if (!e.isFreeway || e.length < 900 || e.isRoundaboutRing) continue;
    const next = e.nextEdgeIds.map((id) => byId.get(id)).filter((n): n is Edge3D => !!n);
    // A ramp is a way on that is a smaller road than the one it leaves; the mainline carries on at the same size.
    const smaller = (n: Edge3D) => n.lanes < e.lanes || n.roadClassId !== e.roadClassId;
    const ramp = next.find(smaller);
    const stays = next.some((n) => !smaller(n));
    if (ramp && stays) {
      exitNumber += 1;
      const num = String(exitNumber);
      out.push(place(e, e.length - 1400, signTexture(`adv:${num}`, (g, w, h) => guideSign(g, w, h, `EXIT ${num}`, "1 MILE")), `${e.id}:adv`));
      out.push(place(e, e.length - 380, signTexture(`exit:${num}`, (g, w, h) => guideSign(g, w, h, `EXIT ${num}`, "↗", "RAMP")), `${e.id}:exit`));
    }
  }
  // A route shield on every freeway that nothing else feeds into.
  const fed = new Set<string>();
  for (const e of edges) for (const id of e.nextEdgeIds) fed.add(id);
  let route = 10;
  for (const e of edges) {
    if (!e.isFreeway || e.roadClassId !== "motorway" || e.length < 900 || fed.has(e.id)) continue;
    out.push(place(e, 220, shieldTexture(route), `${e.id}:shield`, true));
    route += 5;
  }
  return out;
}

const postGeometry = new THREE.BoxGeometry(0.8, 1, 0.8);
const postMaterial = new THREE.MeshStandardMaterial({ color: "#8d949e", roughness: 0.6, metalness: 0.4 });

function Sign({ p }: { p: Placement }) {
  const clearance = 7;
  return (
    <group position={p.position} quaternion={p.quaternion}>
      <mesh geometry={postGeometry} material={postMaterial} position={[-p.width * 0.3, clearance / 2, -0.3]} scale={[1, clearance, 1]} />
      <mesh geometry={postGeometry} material={postMaterial} position={[p.width * 0.3, clearance / 2, -0.3]} scale={[1, clearance, 1]} />
      {/* Leaned back so the face also reads from the game's high camera. */}
      <mesh position={[0, clearance + p.height / 2, 0]} rotation={[-0.75, 0, 0]}>
        <planeGeometry args={[p.width, p.height]} />
        <meshBasicMaterial map={p.texture} transparent toneMapped={false} />
      </mesh>
    </group>
  );
}

function FreewaySigns() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const network = useMemo(() => assembleCached(nodes, edges), [nodes, edges]);
  const signs = useMemo(() => buildSigns(network.edges), [network]);
  return (
    <group>
      {signs.map((p) => (
        <Sign key={p.key} p={p} />
      ))}
    </group>
  );
}

export default memo(FreewaySigns);
