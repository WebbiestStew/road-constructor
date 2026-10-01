"use client";

import { memo } from "react";
import { useEditorStore } from "@/state/editorStore";
import { getScenarioById } from "@/sim/scenarios";

/** Decorative-only river/cliff dressing for the active campaign scenario's narrative — never affects gameplay or pathing. */
function ScenarioTerrainFeature() {
  const activeScenarioId = useEditorStore((s) => s.activeScenarioId);
  const scenario = activeScenarioId ? getScenarioById(activeScenarioId) : undefined;
  const feature = scenario?.terrainFeature;
  if (!feature) return null;

  const width = feature.x2 - feature.x1;
  const depth = feature.z2 - feature.z1;
  const cx = (feature.x1 + feature.x2) / 2;
  const cz = (feature.z1 + feature.z2) / 2;

  if (feature.kind === "river") {
    return (
      <mesh position={[cx, 0.4, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#4fa8d8" transparent opacity={0.88} roughness={0.25} metalness={0.1} />
      </mesh>
    );
  }

  // Cliff: a shaded rocky ground patch plus a vertical rock-face wall marking the elevation break.
  return (
    <group>
      <mesh position={[cx, 0.3, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#8a7a68" roughness={0.95} />
      </mesh>
      <mesh position={[cx, 20, cz - depth / 2 + 4]} castShadow receiveShadow>
        <boxGeometry args={[width, 80, 8]} />
        <meshStandardMaterial color="#6b5c4d" roughness={0.9} />
      </mesh>
    </group>
  );
}

/** Memoized: the game page re-renders several times a second with live traffic stats, and none of this scene depends on them. */
export default memo(ScenarioTerrainFeature);
