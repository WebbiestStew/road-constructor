"use client";

import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { assembleCached } from "@/sim/assembleCache";
import { useEditorStore } from "@/state/editorStore";
import { buildCurb, visibleRanges } from "./roadGeometry";

/** Matches the shoulder drawn beside the lanes in RoadNetworkMesh. */
const SHOULDER_FT = 4;

/**
 * Six-inch kerbs along the edges of ordinary streets and avenues, so the pavement stands proud of the grass instead of
 * lying on it like a printed ribbon. (Freeways have their barriers and bridges their rails.) Every kerb in the
 * network is merged into one mesh, so they cost a single draw call, and they stop where another road crosses.
 */
function Curbs() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const network = useMemo(() => assembleCached(nodes, edges), [nodes, edges]);
  const geometry = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    for (const e of network.edges) {
      if (e.isFreeway || e.isElevated || e.sunken || e.isRoundaboutRing || e.isTexasTurnaround || e.length < 40) continue;
      const off = (e.lanes * e.laneWidthFt) / 2 + SHOULDER_FT - 0.4;
      for (const side of [-off, off]) {
        for (const [a, b] of visibleRanges(e, side)) parts.push(buildCurb(e, side, a, b));
      }
    }
    if (parts.length === 0) return null;
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return merged;
  }, [network]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) return null;
  return (
    <mesh geometry={geometry} receiveShadow castShadow>
      <meshStandardMaterial color="#b9b6ad" roughness={0.9} side={THREE.DoubleSide} />
    </mesh>
  );
}

export default memo(Curbs);
