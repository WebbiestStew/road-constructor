"use client";

import { useEffect } from "react";
import { useEditorStore } from "@/state/editorStore";
import { pushToast } from "@/lib/toast";

const ROAD_TOOLS = new Set(["lanes", "speed", "street", "inspect", "transit", "gantry"]);

/**
 * Keyboard access to the road tools: N steps to the next road, Shift+N to the previous one, centring the camera on it
 * and selecting it, so lane arrows, speed limits, streets and bus lines can be used without clicking in the 3D view.
 * Renders nothing.
 */
export default function KeyboardRoads() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const s = useEditorStore.getState();
      if (!ROAD_TOOLS.has(s.tool) || s.edges.length === 0) return;
      e.preventDefault();
      // Walk the roads in a stable order, one per pair of directions, starting from what is selected now.
      const ids = s.edges.filter((ed) => ed.id < (s.edges.find((o) => o.fromNodeId === ed.toNodeId && o.toNodeId === ed.fromNodeId)?.id ?? "￿") || !s.edges.some((o) => o.fromNodeId === ed.toNodeId && o.toNodeId === ed.fromNodeId)).map((ed) => ed.id);
      if (ids.length === 0) return;
      const cur = s.selection?.kind === "edge" ? ids.indexOf(s.selection.id) : -1;
      const next = (cur + (e.shiftKey ? -1 : 1) + ids.length * 2) % ids.length;
      const edge = s.edgesById.get(ids[next])!;
      const a = s.nodesById.get(edge.fromNodeId);
      const b = s.nodesById.get(edge.toNodeId);
      if (!a || !b) return;
      if (s.tool === "transit") s.extendTransit(edge.id);
      else s.setSelection({ kind: "edge", id: edge.id });
      s.requestCameraFit({ centerX: (a.position[0] + b.position[0]) / 2, centerZ: (a.position[2] + b.position[2]) / 2 });
      pushToast(`Road ${next + 1} of ${ids.length}`, "info");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
