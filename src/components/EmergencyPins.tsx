"use client";

import { useRef, type RefObject, memo } from "react";
import { useFrame } from "@react-three/fiber";
import { WorldLabel } from "./WorldLabels";
import type * as THREE from "three";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";

const MAX_PINS = 4;

/** A pulsing ambulance pin that follows each ambulance on the road, so the player can find it in a busy map. */
function EmergencyPins({ snapshotRef }: { snapshotRef: RefObject<VehicleSnapshot | null> }) {
  const groups = useRef<(THREE.Group | null)[]>([]);
  const labels = useRef<(HTMLDivElement | null)[]>([]);

  useFrame(() => {
    const list = snapshotRef.current?.ambulances ?? [];
    for (let i = 0; i < MAX_PINS; i++) {
      const g = groups.current[i];
      if (!g) continue;
      const p = list[i];
      g.visible = !!p;
      // drei's Html ignores a hidden parent, so the DOM pin is shown and hidden directly.
      const label = labels.current[i];
      if (label) label.style.display = p ? "flex" : "none";
      if (p) g.position.set(p[0], p[1] + 14, p[2]);
    }
  });

  return (
    <>
      {Array.from({ length: MAX_PINS }).map((_, i) => (
        <group key={i} ref={(g) => { groups.current[i] = g; }} visible={false}>
          <WorldLabel center zIndex={15}>
            <div ref={(el) => { labels.current[i] = el; }} style={{ display: "none" }} className="animate-warn-pulse flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-gradient-to-br from-red-500 to-blue-600 text-lg shadow-lg">
              🚑
            </div>
          </WorldLabel>
        </group>
      ))}
    </>
  );
}

export default memo(EmergencyPins);
