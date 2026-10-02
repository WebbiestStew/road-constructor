"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { assembleCached } from "@/sim/assembleCache";
import { useEditorStore } from "@/state/editorStore";

/** Draws each bus line as a coloured ribbon just above its roads, with a thicker line for the one being drawn. */
function TransitLines() {
  const lines = useEditorStore((s) => s.transitLines);
  const activeId = useEditorStore((s) => s.activeTransitId);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const tool = useEditorStore((s) => s.tool);

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
      {drawn.map((d) =>
        d.pts.length >= 2 ? (
          <Line key={d.id} points={d.pts} color={d.color} lineWidth={d.id === activeId ? 7 : emphasise ? 5 : 3.5} transparent opacity={0.9} depthTest={false} renderOrder={5} />
        ) : null
      )}
    </>
  );
}

export default memo(TransitLines);
