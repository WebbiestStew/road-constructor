"use client";

import { useEffect, useRef } from "react";
import { useEditorStore } from "@/state/editorStore";
import { badgeColorForIndex } from "./badgeColors";

const CANVAS_W = 208;
const CANVAS_H = 140;
const PADDING = 14;

export default function Minimap() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "#e7dfc6";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (nodes.length === 0) {
      ctx.fillStyle = "#8a8266";
      ctx.font = "10px var(--font-ui), sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Nothing built yet", CANVAS_W / 2, CANVAS_H / 2);
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position[0]);
      maxX = Math.max(maxX, n.position[0]);
      minZ = Math.min(minZ, n.position[2]);
      maxZ = Math.max(maxZ, n.position[2]);
    }
    const spanX = Math.max(maxX - minX, 200);
    const spanZ = Math.max(maxZ - minZ, 200);
    const availW = CANVAS_W - PADDING * 2;
    const availH = CANVAS_H - PADDING * 2;
    const scale = Math.min(availW / spanX, availH / spanZ);
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;

    const project = (x: number, z: number): [number, number] => [
      CANVAS_W / 2 + (x - centerX) * scale,
      CANVAS_H / 2 + (z - centerZ) * scale,
    ];

    const nodesById = new Map(nodes.map((n) => [n.id, n]));

    ctx.lineCap = "round";
    for (const edge of edges) {
      const from = nodesById.get(edge.fromNodeId);
      const to = nodesById.get(edge.toNodeId);
      if (!from || !to) continue;
      const [x1, y1] = project(from.position[0], from.position[2]);
      const [x2, y2] = project(to.position[0], to.position[2]);
      ctx.strokeStyle = edge.isRoundaboutRing ? "#0d9488" : "#4b5266";
      ctx.lineWidth = edge.isRoundaboutRing ? 1.5 : Math.max(1.2, edge.lanes * 0.8);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    let colorIdx = 0;
    for (const edge of edges) {
      if (!edge.zone) continue;
      const node = nodesById.get(edge.zone.type === "entry" ? edge.fromNodeId : edge.toNodeId);
      const color = badgeColorForIndex(colorIdx);
      colorIdx++;
      if (!node) continue;
      const [x, y] = project(node.position[0], node.position[2]);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }, [nodes, edges]);

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-20">
      <div className="hud-panel overflow-hidden rounded-xl p-1">
        <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="block rounded-lg" />
      </div>
    </div>
  );
}
