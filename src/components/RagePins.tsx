"use client";

import { memo } from "react";
import { usePhotoMode } from "@/lib/photoMode";
import { WorldLabel } from "./WorldLabels";

/** A red stress icon over the drivers who have sat stopped for more than five seconds (a handful, spread along the queue). */
function RagePins({ markers }: { markers: [number, number, number][] }) {
  const photo = usePhotoMode();
  return (
    <>
      {markers.map((p, i) => (
        <WorldLabel key={i} position={[p[0], p[1] + 12, p[2]]} center zIndex={12} hidden={photo}>
          <div className="animate-warn-pulse pointer-events-none select-none text-center leading-none" style={{ transform: "translateY(-6px)" }}>
            <span className="text-lg drop-shadow-[0_1px_0_rgba(0,0,0,0.5)]">😡</span>
            <span className="-ml-1 align-top text-xs font-black text-red-500 drop-shadow-[0_1px_0_#fff]">💢</span>
          </div>
        </WorldLabel>
      ))}
    </>
  );
}

export default memo(RagePins);
