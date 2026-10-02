"use client";

import { useEditorStore } from "@/state/editorStore";

/** The map credit OpenStreetMap's licence asks for, shown whenever real roads are on screen (and which place is loaded, if the player picked one). */
export default function PlaceCredit() {
  const real = useEditorStore((s) => s.realCityActive);
  const placeName = useEditorStore((s) => s.placeName);
  if (!real) return null;
  return (
    <div className="pointer-events-auto absolute bottom-1 left-[9rem] z-10 rounded-full bg-white/70 px-2.5 py-0.5 text-[9.5px] font-semibold text-zinc-600 max-md:hidden">
      {placeName ? `📍 ${placeName} · ` : ""}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">
        © OpenStreetMap contributors
      </a>
    </div>
  );
}
