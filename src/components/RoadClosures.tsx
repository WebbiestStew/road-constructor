"use client";

import { memo, useMemo } from "react";
import { assembleCached } from "@/sim/assembleCache";
import { useEditorStore } from "@/state/editorStore";
import { usePhotoMode } from "@/lib/photoMode";
import { WorldLabel } from "./WorldLabels";

/** A flashing "road closed" marker over every road a scripted event has closed (a bridge out, a burst main). */
function RoadClosures({ closed }: { closed: string[] }) {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const photo = usePhotoMode();
  const marks = useMemo(() => {
    if (closed.length === 0) return [];
    const net = assembleCached(nodes, edges);
    return closed.flatMap((id) => {
      const e = net.edgesById.get(id);
      if (!e) return [];
      const p = e.spline.getPointAt(0.5);
      return [{ id, pos: [p.x, p.y + 14, p.z] as [number, number, number] }];
    });
  }, [closed, nodes, edges]);
  return (
    <>
      {marks.map((m) => (
        <WorldLabel key={m.id} position={m.pos} center zIndex={14} hidden={photo}>
          <div className="animate-warn-pulse pointer-events-none select-none whitespace-nowrap rounded-lg border-2 border-white bg-gradient-to-br from-amber-400 to-red-600 px-2.5 py-1 text-[11px] font-extrabold uppercase text-white shadow-lg">
            🚧 Road closed
          </div>
        </WorldLabel>
      ))}
    </>
  );
}

export default memo(RoadClosures);
