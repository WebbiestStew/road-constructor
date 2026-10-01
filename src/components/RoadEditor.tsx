"use client";

import { useEffect, useMemo, useRef, useState, memo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { useEditorStore } from "@/state/editorStore";
import { ELEVATION_BY_ID, ROAD_CLASSES, ROAD_CLASS_LIST, estimateEdgeCost } from "@/sim/roadClasses";
import { computeGradePercent, MAX_GRADE_PERCENT } from "@/sim/grade";
import { playDrawWhoosh } from "@/lib/sound";
import { buildAsphaltRibbon } from "./roadGeometry";
import type { Edge3D } from "@/sim/types";

/** Minimum drag distance, in feet, between successive draw-whoosh sound triggers. */
const WHOOSH_DISTANCE_FT = 60;

const NODE_RADIUS_FT = 7;
const NODE_HEIGHT_FT = 2;

/**
 * The interactive road-building layer: an invisible click-catching ground
 * plane, clickable node markers, and a ghost preview of the road segment
 * currently being drawn. Only active in Build mode — Simulate mode hides
 * every editing affordance so the network reads as "open to traffic."
 */
function RoadEditor() {
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const nodes = useEditorStore((s) => s.nodes);
  const drawFromNodeId = useEditorStore((s) => s.drawFromNodeId);
  const selectedElevationId = useEditorStore((s) => s.selectedElevationId);
  const selectedRoadClassId = useEditorStore((s) => s.selectedRoadClassId);
  const twoWay = useEditorStore((s) => s.twoWay);
  const selection = useEditorStore((s) => s.selection);
  const budget = useEditorStore((s) => s.budget);

  const [hoverPoint, setHoverPoint] = useState<[number, number, number] | null>(null);
  const lastWhooshPointRef = useRef<[number, number, number] | null>(null);

  const drawFromNode = drawFromNodeId ? nodes.find((n) => n.id === drawFromNodeId) : null;

  // A semi-transparent 3D preview of the road segment that would be placed
  // right now — snapped to the cursor, at the currently selected class and
  // elevation, so a player sees exactly what they're about to commit to
  // before clicking.
  const ghostEdge = useMemo<Edge3D | null>(() => {
    if (!drawFromNode || !hoverPoint || tool !== "draw") return null;
    const curve = new THREE.CatmullRomCurve3(
      [new THREE.Vector3(...drawFromNode.position), new THREE.Vector3(...hoverPoint)],
      false,
      "catmullrom",
      0.5
    );
    const roadClass = ROAD_CLASSES[selectedRoadClassId];
    return {
      id: "__ghost__",
      fromNodeId: "",
      toNodeId: "",
      spline: curve,
      lanes: roadClass.lanesPerDirection,
      laneWidthFt: roadClass.laneWidthFt,
      speedLimitMph: roadClass.speedLimitMph,
      length: curve.getLength(),
      roadClassId: selectedRoadClassId,
      elevationLevelId: selectedElevationId,
      priority: roadClass.priority,
      isFreeway: false,
      isElevated: false,
      isRoundaboutRing: false,
      isTexasTurnaround: false,
      nextEdgeIds: [],
      manualLaneMoves: null,
      nextMoves: new Map(),
      laneAllowed: null,
      laneMoves: [],
      autoLaneMoves: [],
    };
  }, [drawFromNode, hoverPoint, tool, selectedRoadClassId, selectedElevationId]);

  const ghostGeometry = useMemo(() => (ghostEdge ? buildAsphaltRibbon(ghostEdge, 3) : null), [ghostEdge]);

  useEffect(() => {
    if (!drawFromNodeId) lastWhooshPointRef.current = null;
  }, [drawFromNodeId]);

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
      if (e.key.toLowerCase() === "q") {
        store.stepElevation(-1);
        return;
      }
      if (e.key.toLowerCase() === "e") {
        store.stepElevation(1);
        return;
      }
      if (e.key.toLowerCase() === "b") {
        store.setTool("draw");
        return;
      }
      if (e.key.toLowerCase() === "z") {
        store.setTool("zone");
        return;
      }
      if (e.key.toLowerCase() === "i") {
        store.setTool("inspect");
        return;
      }
      if (e.key.toLowerCase() === "x") {
        store.setTool("delete");
        return;
      }
      if (e.key.toLowerCase() === "t") {
        store.setTool("turnaround");
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
    const point: [number, number, number] = [event.point.x, elevationFt, event.point.z];
    setHoverPoint(point);

    const last = lastWhooshPointRef.current;
    if (!last) {
      lastWhooshPointRef.current = point;
    } else {
      const dx = point[0] - last[0];
      const dz = point[2] - last[2];
      if (Math.sqrt(dx * dx + dz * dz) >= WHOOSH_DISTANCE_FT) {
        lastWhooshPointRef.current = point;
        playDrawWhoosh();
      }
    }
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

  let dragInfo: {
    midpoint: [number, number, number];
    lengthFt: number;
    costLabel: string;
    gradePercent: number;
    overBudget: boolean;
  } | null = null;
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
      gradePercent: computeGradePercent(drawFromNode.position, hoverPoint),
      overBudget: totalCost > budget,
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
          color={dragInfo?.overBudget ? "#ef4444" : "#38bdf8"}
          lineWidth={3}
          dashed
          dashScale={4}
          transparent
          opacity={0.8}
        />
      )}

      {ghostGeometry && (
        <mesh geometry={ghostGeometry} position={[0, 0.15, 0]}>
          <meshStandardMaterial
            color={dragInfo?.overBudget ? "#ef4444" : "#38bdf8"}
            transparent
            opacity={0.4}
            depthWrite={false}
            emissive={dragInfo?.overBudget ? "#ef4444" : "#38bdf8"}
            emissiveIntensity={0.25}
          />
        </mesh>
      )}

      {dragInfo && (
        <Html position={dragInfo.midpoint} style={{ pointerEvents: "none" }} zIndexRange={[10, 0]}>
          <div
            className="animate-pop"
            style={{
              transform: "translate(-50%, -150%)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: dragInfo.overBudget
                ? "linear-gradient(180deg, #f87171, #dc2626)"
                : "linear-gradient(180deg, #27272e, #1c1c20)",
              color: "#f4f4f5",
              fontSize: 12,
              fontWeight: 700,
              padding: "6px 12px",
              borderRadius: 999,
              whiteSpace: "nowrap",
              boxShadow: "0 3px 10px rgba(0,0,0,0.4)",
              border: dragInfo.overBudget ? "1.5px solid #7f1d1d" : "1.5px solid rgba(255,255,255,0.12)",
              fontFamily: "var(--font-sans)",
            }}
          >
            <span className="tabular-nums">{Math.round(dragInfo.lengthFt)} ft</span>
            <span style={{ opacity: 0.5 }}>&middot;</span>
            <span className="tabular-nums">{dragInfo.costLabel}</span>
            {dragInfo.overBudget && <span style={{ fontSize: 10 }}>⚠ OVER BUDGET</span>}
            {Math.abs(dragInfo.gradePercent) >= 0.5 && (
              <>
                <span style={{ opacity: 0.5 }}>&middot;</span>
                <span
                  className="tabular-nums"
                  style={{ color: Math.abs(dragInfo.gradePercent) > MAX_GRADE_PERCENT ? "#fecaca" : "#f4f4f5" }}
                >
                  {dragInfo.gradePercent > 0 ? "+" : ""}
                  {dragInfo.gradePercent.toFixed(1)}%
                </span>
              </>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

/** Memoized: the game page re-renders several times a second with live traffic stats, and none of this scene depends on them. */
export default memo(RoadEditor);
