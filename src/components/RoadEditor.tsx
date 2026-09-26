"use client";

import { useEffect, useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import { useEditorStore } from "@/state/editorStore";
import { ELEVATION_BY_ID, ROAD_CLASSES, ROAD_CLASS_LIST, estimateEdgeCost } from "@/sim/roadClasses";

const NODE_RADIUS_FT = 7;
const NODE_HEIGHT_FT = 2;

/**
 * The interactive road-building layer: an invisible click-catching ground
 * plane, clickable node markers, and a ghost preview of the road segment
 * currently being drawn. Only active in Build mode — Simulate mode hides
 * every editing affordance so the network reads as "open to traffic."
 */
export default function RoadEditor() {
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const nodes = useEditorStore((s) => s.nodes);
  const drawFromNodeId = useEditorStore((s) => s.drawFromNodeId);
  const selectedElevationId = useEditorStore((s) => s.selectedElevationId);
  const selectedRoadClassId = useEditorStore((s) => s.selectedRoadClassId);
  const twoWay = useEditorStore((s) => s.twoWay);
  const selection = useEditorStore((s) => s.selection);

  const [hoverPoint, setHoverPoint] = useState<[number, number, number] | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const store = useEditorStore.getState();
      if (e.key === "Escape") {
        store.cancelDrawChain();
        store.setSelection(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        store.redo();
        return;
      }
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < ROAD_CLASS_LIST.length) {
        store.setRoadClass(ROAD_CLASS_LIST[idx].id);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (mode !== "build") return null;

  const elevationFt = ELEVATION_BY_ID[selectedElevationId].elevationFt;

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (tool !== "draw" || !drawFromNodeId) return;
    setHoverPoint([event.point.x, elevationFt, event.point.z]);
  };

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const store = useEditorStore.getState();
    const point: [number, number, number] = [event.point.x, elevationFt, event.point.z];

    if (store.tool === "draw") {
      if (store.drawFromNodeId) {
        store.drawTo(store.drawFromNodeId, null, point);
      } else {
        const id = store.createNodeAt(point);
        store.startDrawChain(id);
      }
    } else if (store.tool === "inspect") {
      store.setSelection(null);
    }
  };

  const handleContextMenu = (event: ThreeEvent<MouseEvent>) => {
    event.nativeEvent.preventDefault();
    useEditorStore.getState().cancelDrawChain();
  };

  const handleNodeClick = (nodeId: string, position: [number, number, number]) => (
    event: ThreeEvent<MouseEvent>
  ) => {
    event.stopPropagation();
    const store = useEditorStore.getState();
    if (store.tool === "draw") {
      if (store.drawFromNodeId) {
        store.drawTo(store.drawFromNodeId, nodeId, position);
      } else {
        store.startDrawChain(nodeId);
      }
    } else if (store.tool === "delete") {
      store.deleteNode(nodeId);
    } else if (store.tool === "inspect") {
      store.setSelection({ kind: "node", id: nodeId });
    }
  };

  const drawFromNode = drawFromNodeId ? nodes.find((n) => n.id === drawFromNodeId) : null;

  let dragInfo: { midpoint: [number, number, number]; lengthFt: number; costLabel: string } | null = null;
  if (drawFromNode && hoverPoint) {
    const dx = hoverPoint[0] - drawFromNode.position[0];
    const dy = hoverPoint[1] - drawFromNode.position[1];
    const dz = hoverPoint[2] - drawFromNode.position[2];
    const lengthFt = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const roadClass = ROAD_CLASSES[selectedRoadClassId];
    const costOneWay = estimateEdgeCost(selectedRoadClassId, selectedElevationId, lengthFt, roadClass.lanesPerDirection);
    const totalCost = twoWay ? costOneWay * 2 : costOneWay;
    dragInfo = {
      midpoint: [
        (drawFromNode.position[0] + hoverPoint[0]) / 2,
        (drawFromNode.position[1] + hoverPoint[1]) / 2,
        (drawFromNode.position[2] + hoverPoint[2]) / 2,
      ],
      lengthFt,
      costLabel: `$${Math.round(totalCost).toLocaleString()}`,
    };
  }

  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.05, 0]}
        onPointerMove={handlePointerMove}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <planeGeometry args={[30000, 30000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {nodes.map((node) => {
        const isDrawSource = node.id === drawFromNodeId;
        const isSelected = selection?.kind === "node" && selection.id === node.id;
        const isSignal = node.control?.type === "signal";
        const color = isDrawSource
          ? "#38bdf8"
          : isSelected
            ? "#f472b6"
            : isSignal
              ? "#eab308"
              : "#9ca3af";
        return (
          <mesh
            key={node.id}
            position={[node.position[0], node.position[1] + NODE_HEIGHT_FT / 2, node.position[2]]}
            onClick={handleNodeClick(node.id, node.position)}
          >
            <cylinderGeometry args={[NODE_RADIUS_FT, NODE_RADIUS_FT, NODE_HEIGHT_FT, 20]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
          </mesh>
        );
      })}

      {tool === "draw" && drawFromNode && hoverPoint && (
        <Line
          points={[
            [drawFromNode.position[0], drawFromNode.position[1] + 3, drawFromNode.position[2]],
            [hoverPoint[0], hoverPoint[1] + 3, hoverPoint[2]],
          ]}
          color="#38bdf8"
          lineWidth={3}
          dashed
          dashScale={4}
          transparent
          opacity={0.8}
        />
      )}

      {dragInfo && (
        <Html position={dragInfo.midpoint} style={{ pointerEvents: "none" }} zIndexRange={[10, 0]}>
          <div
            style={{
              transform: "translate(-50%, -140%)",
              background: "#1c1c20",
              color: "#f4f4f5",
              fontSize: 11,
              fontWeight: 600,
              padding: "4px 8px",
              borderRadius: 6,
              whiteSpace: "nowrap",
              boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
              fontFamily: "var(--font-sans)",
            }}
          >
            {Math.round(dragInfo.lengthFt)} ft &middot; {dragInfo.costLabel}
          </div>
        </Html>
      )}
    </group>
  );
}
