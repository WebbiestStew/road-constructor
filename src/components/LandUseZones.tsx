"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { nearestRoadPoint, LAND_USE_KINDS } from "@/sim/landUse";
import { useEditorStore } from "@/state/editorStore";
import { usePhotoMode } from "@/lib/photoMode";
import { WorldLabel } from "./WorldLabels";

const COLORS = { home: "#7bc47f", work: "#6b8fd6", shop: "#f0a23b" } as const;
const ROOF = { home: "#c0563f", work: "#4b5f8f", shop: "#b8661c" } as const;
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);

/** The homes, jobs and shops the player has placed: a coloured pad with a building on it, a line to the road it feeds, and (with the land-use tool) a button to take it away. */
function LandUseZones() {
  const zones = useEditorStore((s) => s.landUse);
  const edges = useEditorStore((s) => s.edges);
  const nodes = useEditorStore((s) => s.nodes);
  const tool = useEditorStore((s) => s.tool);
  const mode = useEditorStore((s) => s.mode);
  const remove = useEditorStore((s) => s.removeLandUse);
  const photo = usePhotoMode();

  const links = useMemo(() => {
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    return zones.map((z) => {
      const edge = edges.find((e) => e.landUseId === z.id);
      const near = edge ? nearestRoadPoint(edge, nodesById, z.position) : null;
      return near ? ([[z.position[0], 0.6, z.position[1]], [near.point[0], 0.6, near.point[1]]] as [number, number, number][]) : null;
    });
  }, [zones, edges, nodes]);

  if (zones.length === 0) return null;
  const editing = tool === "landuse" && mode === "build";
  return (
    <>
      {zones.map((z, i) => {
        const pad = 34 + z.size * 16;
        const h = z.kind === "work" ? 24 + z.size * 26 : z.kind === "shop" ? 12 + z.size * 4 : 10 + z.size * 3;
        const w = pad * (z.kind === "work" ? 0.55 : 0.7);
        return (
          <group key={z.id} position={[z.position[0], 0, z.position[1]]}>
            <mesh geometry={boxGeometry} scale={[pad, 0.5, pad]} position={[0, 0.25, 0]} receiveShadow>
              <meshStandardMaterial color={COLORS[z.kind]} roughness={0.95} />
            </mesh>
            <mesh geometry={boxGeometry} scale={[w, h, w]} position={[0, h / 2 + 0.5, 0]} castShadow receiveShadow>
              <meshStandardMaterial color="#efe9df" roughness={0.85} />
            </mesh>
            <mesh geometry={boxGeometry} scale={[w * 1.08, 2.4, w * 1.08]} position={[0, h + 1.7, 0]} castShadow>
              <meshStandardMaterial color={ROOF[z.kind]} roughness={0.8} />
            </mesh>
            {!photo && (
              <WorldLabel position={[z.position[0], h + 16, z.position[1]]} center zIndex={7} hidden={photo}>
                <div className="flex items-center gap-1" style={{ pointerEvents: editing ? "auto" : "none" }}>
                  <span className="rounded-full bg-white/95 px-1.5 py-0.5 text-[13px] leading-none shadow ring-1 ring-black/10">{LAND_USE_KINDS.find((k) => k.id === z.kind)?.emoji}</span>
                  {editing && (
                    <button type="button" onClick={() => remove(z.id)} aria-label="Remove this zone" className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-extrabold leading-none text-white shadow">
                      ✕
                    </button>
                  )}
                </div>
              </WorldLabel>
            )}
            {links[i] && (
              <group position={[-z.position[0], 0, -z.position[1]]}>
                <Line points={links[i]!} color={COLORS[z.kind]} lineWidth={2} dashed dashSize={6} gapSize={5} transparent opacity={0.8} />
              </group>
            )}
          </group>
        );
      })}
    </>
  );
}

export default memo(LandUseZones);
