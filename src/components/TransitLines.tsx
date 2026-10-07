"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { assembleCached } from "@/sim/assembleCache";
import { useEditorStore } from "@/state/editorStore";
import { usePhotoMode } from "@/lib/photoMode";
import { WorldLabel } from "./WorldLabels";

/** Draws each bus line as a coloured ribbon just above its roads, with a thicker line for the one being drawn. */
function TransitLines() {
  const lines = useEditorStore((s) => s.transitLines);
  const activeId = useEditorStore((s) => s.activeTransitId);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const tool = useEditorStore((s) => s.tool);
  const photo = usePhotoMode();

  // Stops on a road that two or more lines share are transfer stops: people change lines there.
  const transfers = useMemo(() => {
    if (lines.length < 2) return [];
    const count = new Map<string, number>();
    for (const l of lines) for (const id of new Set(l.edgeIds)) count.set(id, (count.get(id) ?? 0) + 1);
    const shared = edges.filter((e) => e.busStop && (count.get(e.id) ?? 0) >= 2);
    if (shared.length === 0) return [];
    const net = assembleCached(nodes, edges);
    const out: { id: string; pos: [number, number, number] }[] = [];
    for (const e of shared) {
      const edge = net.edgesById.get(e.id);
      if (!edge) continue;
      const p = edge.spline.getPointAt(0.6);
      out.push({ id: e.id, pos: [p.x, p.y + 14, p.z] });
    }
    return out;
  }, [lines, nodes, edges]);

  const drawn = useMemo(() => {
    if (lines.length === 0) return [];
    const net = assembleCached(nodes, edges);
    return lines.map((l) => {
      const pts: THREE.Vector3[] = [];
      for (const id of l.edgeIds) {
        const e = net.edgesById.get(id);
        if (!e) continue;
        const n = Math.max(2, Math.round(e.length / 40));
        for (let i = 0; i <= n; i++) {
          const p = e.spline.getPointAt(i / n);
          // the line rides on the carriageway the buses use (shifted to its side, and toward the right-hand lane)
          const t = e.spline.getTangentAt(i / n);
          const len = Math.hypot(t.x, t.z) || 1;
          const side = e.lateralShiftFt + ((e.lanes - 1) * e.laneWidthFt) / 2;
          pts.push(new THREE.Vector3(p.x + (-t.z / len) * side, p.y + 1.6, p.z + (t.x / len) * side));
        }
      }
      return { id: l.id, color: l.color, pts };
    });
  }, [lines, nodes, edges]);

  if (drawn.length === 0) return null;
  const emphasise = tool === "transit";
  return (
    <>
      {transfers.map((t) => (
        <WorldLabel key={t.id} position={t.pos} center zIndex={8} hidden={photo}>
          <div className="pointer-events-none select-none rounded-full bg-white/95 px-1.5 py-0.5 text-[10px] font-extrabold text-violet-700 shadow ring-1 ring-violet-300" title="Transfer stop: two or more lines meet here">
            🔁 Transfer
          </div>
        </WorldLabel>
      ))}
      {drawn.map((d) =>
        d.pts.length >= 2 ? (
          <Line key={d.id} points={d.pts} color={d.color} lineWidth={d.id === activeId ? 7 : emphasise ? 5 : 3.5} transparent opacity={0.9} depthTest={false} renderOrder={5} />
        ) : null
      )}
    </>
  );
}

export default memo(TransitLines);
