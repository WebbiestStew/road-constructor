"use client";

import { useEffect } from "react";
import { useEditorStore } from "@/state/editorStore";
import { IconWarning } from "./icons";

const AUTO_DISMISS_MS = 3000;

/** A brief, auto-dismissing toast for rejected build actions (e.g. a road that would violate bridge clearance). */
export default function BuildWarningToast() {
  const buildWarning = useEditorStore((s) => s.buildWarning);
  const setBuildWarning = useEditorStore((s) => s.setBuildWarning);

  useEffect(() => {
    if (!buildWarning) return;
    const timer = setTimeout(() => setBuildWarning(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [buildWarning, setBuildWarning]);

  if (!buildWarning) return null;

  return (
    <div className="pointer-events-none absolute top-44 left-1/2 z-30 -translate-x-1/2 lg:top-20">
      <div className="animate-pop flex items-center gap-2 rounded-full border-2 border-amber-700/40 bg-gradient-to-br from-amber-500 to-orange-600 px-4 py-2 text-xs font-bold text-white shadow-lg">
        <IconWarning className="h-3.5 w-3.5" />
        {buildWarning}
      </div>
    </div>
  );
}
