"use client";

import { memo, useEffect, useRef } from "react";
import type { IncidentView } from "@/sim/types";
import { WRECKER_COST, isSandboxBudget, useEditorStore } from "@/state/editorStore";
import { pushToast } from "@/lib/toast";
import { usePhotoMode } from "@/lib/photoMode";
import { WorldLabel } from "./WorldLabels";

const KIND_EMOJI: Record<IncidentView["kind"], string> = { stall: "🚛", debris: "🧱", crash: "💥" };
const KIND_TEXT: Record<IncidentView["kind"], string> = {
  stall: "A semi has stalled and is blocking its lane",
  debris: "Debris on the road is blocking a lane",
  crash: "A crash is blocking the road",
};

/** A pin over every incident on the road, with a button that sends a wrecker; also announces new ones and clears. */
function IncidentPins({ incidents, onDispatch }: { incidents: IncidentView[]; onDispatch: (id: number) => void }) {
  const known = useRef(new Map<number, IncidentView["kind"]>());
  const budget = useEditorStore((s) => s.budget);
  const spendBudget = useEditorStore((s) => s.spendBudget);
  const photo = usePhotoMode();

  useEffect(() => {
    const seen = known.current;
    const now = new Set<number>();
    for (const inc of incidents) {
      now.add(inc.id);
      if (!seen.has(inc.id)) {
        seen.set(inc.id, inc.kind);
        pushToast(`${KIND_EMOJI[inc.kind]} ${KIND_TEXT[inc.kind]}. Reroute, retime the lights, or send a wrecker.`, "alert");
      }
    }
    for (const [id, kind] of seen) {
      if (!now.has(id)) {
        seen.delete(id);
        pushToast(`${KIND_EMOJI[kind]} The lane is clear again`, "good");
      }
    }
  }, [incidents]);

  const dispatch = (inc: IncidentView) => {
    if (!spendBudget(WRECKER_COST)) return;
    onDispatch(inc.id);
  };
  const free = isSandboxBudget(budget);

  return (
    <>
      {incidents.map((inc) => (
        <WorldLabel key={inc.id} position={[inc.position[0], inc.position[1] + 16, inc.position[2]]} center zIndex={16} hidden={photo}>
          <div className="flex flex-col items-center gap-1" style={{ pointerEvents: "auto" }}>
            <div className="animate-warn-pulse flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-gradient-to-br from-amber-400 to-red-500 text-lg shadow-lg">
              {KIND_EMOJI[inc.kind]}
            </div>
            {inc.wrecker === "none" ? (
              <button
                type="button"
                onClick={() => dispatch(inc)}
                className="whitespace-nowrap rounded-lg border-2 border-[#2b1c40] bg-gradient-to-br from-amber-300 to-orange-400 px-2 py-1 text-[11px] font-extrabold text-[#2b1c40] shadow-[0_2px_0_#2b1c40] transition active:scale-95 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3.5 [@media(pointer:coarse)]:text-xs"
              >
                Send wrecker{free ? "" : ` · $${(WRECKER_COST / 1000).toFixed(0)}k`}
              </button>
            ) : (
              <span className="whitespace-nowrap rounded-lg bg-[#241b3d]/90 px-2 py-0.5 text-[10.5px] font-bold text-white">
                {inc.wrecker === "enroute" ? "🚧 Wrecker en route" : "🔧 Clearing…"}
              </span>
            )}
          </div>
        </WorldLabel>
      ))}
    </>
  );
}

export default memo(IncidentPins);
