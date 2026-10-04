"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { assembleCached } from "@/sim/assembleCache";
import { fastTangentAt, laneCenterPointAt } from "@/sim/laneGeometry";
import type { Edge3D } from "@/sim/types";
import { useEditorStore } from "@/state/editorStore";
import { useDetailShed } from "@/lib/perfDetail";

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
  // The main line shrinks to fit, and a long street name wraps onto two lines.
  const fit = (text: string, maxPx: number, startPx: number) => {
    let px = startPx;
    for (; px > 16; px -= 2) {
      g.font = `bold ${px}px system-ui, sans-serif`;
      if (g.measureText(text).width <= maxPx) break;
    }
    return px;
  };
  const maxW = w - 36;
  const words = big.split(" ");
  const oneLinePx = fit(big, maxW, 58);
  if (words.length > 1 && oneLinePx < 30) {
    const mid = Math.ceil(words.length / 2);
    const l1 = words.slice(0, mid).join(" ");
    const l2 = words.slice(mid).join(" ");
    const px = Math.min(fit(l1, maxW, 40), fit(l2, maxW, 40));
    g.font = `bold ${px}px system-ui, sans-serif`;
    g.fillText(l1, w / 2, 64);
    g.fillText(l2, w / 2, 64 + px + 2);
  } else {
    g.font = `bold ${oneLinePx}px system-ui, sans-serif`;
    g.fillText(big, w / 2, small ? 74 : 84);
  }
  if (small) {
    g.font = "bold 22px system-ui, sans-serif";
    g.fillText(small, w / 2, 112);
  }
}

/** A shield for a route reference like "I 35" or "US 77" (the letters in the red band, the number below); `fallback` is used when the map gave none. */
function shieldTexture(ref: string | undefined, fallback: number): THREE.CanvasTexture {
  const m = /^([A-Za-z]+)[\s-]*(\d+\w?)/.exec(ref ?? "");
  const letters = m ? m[1].toUpperCase().slice(0, 3) : "";
  const num = m ? m[2] : String(fallback);
  return signTexture(`shield:${letters}:${num}`, (g, w, h) => {
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
    g.fillRect(cx - 48, 24, 96, 22);
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (letters) {
      g.font = "bold 18px system-ui, sans-serif";
      g.fillText(letters, cx, 36);
    }
    g.font = `bold ${num.length > 2 ? 38 : 46}px system-ui, sans-serif`;
    g.fillText(num, cx, 80);
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

/** Where a ramp leads: its own name, else the first named road beyond it that isn't the freeway itself. */
function rampLabel(ramp: Edge3D, freeway: Edge3D, byId: Map<string, Edge3D>): string | undefined {
  const seen = new Set<string>();
  let frontier: Edge3D[] = [ramp];
  for (let hop = 0; hop < 4 && frontier.length > 0; hop++) {
    const nextFrontier: Edge3D[] = [];
    for (const e of frontier) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.name && e.name !== freeway.name) return e.name;
      for (const id of e.nextEdgeIds) {
        const n = byId.get(id);
        if (n) nextFrontier.push(n);
      }
    }
    frontier = nextFrontier;
  }
  return undefined;
}

function buildSigns(edges: Edge3D[]): Placement[] {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const out: Placement[] = [];
  let exitNumber = 0;
  for (const e of edges) {
    if (!e.isFreeway || e.length < 450 || e.isRoundaboutRing) continue;
    const next = e.nextEdgeIds.map((id) => byId.get(id)).filter((n): n is Edge3D => !!n);
    // A ramp is a way on that is a smaller road than the one it leaves; the mainline carries on at the same size.
    const smaller = (n: Edge3D) => n.lanes < e.lanes || n.roadClassId !== e.roadClassId;
    const ramp = next.find(smaller);
    const stays = next.some((n) => !smaller(n));
    if (ramp && stays) {
      exitNumber += 1;
      const num = String(exitNumber);
      const label = rampLabel(ramp, e, byId);
      const advKey = `adv:${num}:${label ?? ""}`;
      const exitKey = `exit:${num}:${label ?? ""}`;
      if (e.length >= 900) out.push(place(e, e.length - 1400, signTexture(advKey, (g, w, h) => guideSign(g, w, h, `EXIT ${num}`, label ?? "1 MILE", label ? "1 MILE" : undefined)), `${e.id}:adv`));
      out.push(place(e, e.length - Math.min(380, e.length * 0.5), signTexture(exitKey, (g, w, h) => guideSign(g, w, h, `EXIT ${num} ↗`, label ?? "RAMP", label ? "NEXT RIGHT" : undefined)), `${e.id}:exit`));
    }
  }
  // A route shield on every freeway that nothing else feeds into.
  const fed = new Set<string>();
  for (const e of edges) for (const id of e.nextEdgeIds) fed.add(id);
  let route = 10;
  for (const e of edges) {
    if (!e.isFreeway || e.roadClassId !== "motorway" || e.length < 900 || fed.has(e.id)) continue;
    out.push(place(e, 220, shieldTexture(e.ref, route), `${e.id}:shield`, true));
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
  // The guide signs are decoration: first thing to go when the frame rate struggles.
  if (useDetailShed() >= 2) return null;
  return (
    <group>
      {signs.map((p) => (
        <Sign key={p.key} p={p} />
      ))}
    </group>
  );
}

export default memo(FreewaySigns);
