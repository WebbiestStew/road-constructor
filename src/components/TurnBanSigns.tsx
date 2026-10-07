"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { assembleCached } from "@/sim/assembleCache";
import { laneCenterPointAt } from "@/sim/laneGeometry";
import { usePhotoMode } from "@/lib/photoMode";
import { useEditorStore } from "@/state/editorStore";
import { WorldLabel } from "./WorldLabels";

const SIGN_BEFORE_END_FT = 36;
const MAX_SIGNS = 80;

/** "No left turn" and "No right turn" signs beside the approach where the player banned a turn: a red-ringed arrow, set at the kerb just before the stop line. */
function TurnBanSigns() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const photo = usePhotoMode();
  const signs = useMemo(() => {
    if (!edges.some((e) => e.bannedTurns?.length)) return [];
    const network = assembleCached(nodes, edges);
    const out: { key: string; pos: [number, number, number]; turn: "left" | "right" }[] = [];
    const tan = new THREE.Vector3();
    const right = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const edge of network.edges) {
      if (!edge.bannedTurns.length || edge.length < SIGN_BEFORE_END_FT * 2 || out.length >= MAX_SIGNS) continue;
      // beside the right-hand lane
      laneCenterPointAt(edge, Math.max(0, 1 - SIGN_BEFORE_END_FT / edge.length), edge.lanes - 1, tan, right, p);
      p.addScaledVector(right, edge.laneWidthFt * 0.5 + 6);
      for (const turn of edge.bannedTurns) if (turn === "left" || turn === "right") out.push({ key: `${edge.id}:${turn}`, pos: [p.x, p.y + 9, p.z], turn });
    }
    return out;
  }, [nodes, edges]);

  return (
    <>
      {signs.map((s) => (
        <WorldLabel key={s.key} position={s.pos} center zIndex={9} hidden={photo}>
          <div
            className="pointer-events-none flex h-6 w-6 select-none items-center justify-center rounded-full border-[3px] border-red-600 bg-white text-[13px] font-black leading-none text-[#14161c] shadow"
            title={`No ${s.turn} turn`}
          >
            <span className="relative">
              {s.turn === "left" ? "↰" : "↱"}
              <span className="absolute inset-0 flex items-center justify-center text-red-600">⁄</span>
            </span>
          </div>
        </WorldLabel>
      ))}
    </>
  );
}

export default memo(TurnBanSigns);
