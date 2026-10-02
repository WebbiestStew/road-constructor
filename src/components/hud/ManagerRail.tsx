"use client";

import { useEffect, type ComponentType, type SVGProps } from "react";
import { useEditorStore, type EditorTool } from "@/state/editorStore";
import { IconInspect, IconJunction, IconLanes, IconRoad, IconSpeedSign } from "./icons";

const TOOLS: { id: EditorTool; icon: ComponentType<SVGProps<SVGSVGElement>>; label: string; hint: string; key: string }[] = [
  { id: "inspect", icon: IconInspect, label: "Select", hint: "Look at a road or junction", key: "V" },
  { id: "lanes", icon: IconLanes, label: "Lane arrows", hint: "Choose where each lane can go", key: "L" },
  { id: "speed", icon: IconSpeedSign, label: "Speed limits", hint: "Set the limit on a road", key: "P" },
  { id: "junction", icon: IconJunction, label: "Junctions", hint: "Signals, priority, timing", key: "J" },
  { id: "street", icon: IconRoad, label: "Streets", hint: "Bus and bike lanes, one-way, crossings", key: "K" },
];

/** The always-on Traffic Manager: a vertical tool rail that works while traffic is running. */
export default function ManagerRail() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const hit = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (hit) useEditorStore.getState().setTool(hit.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="pointer-events-auto absolute bottom-24 left-4 z-20 flex flex-col items-center gap-1.5 rounded-2xl hud-panel p-1.5 max-md:bottom-auto max-md:left-2 max-md:top-[3.9rem] max-md:flex-row max-md:gap-1 max-md:p-1">
      <span className="font-display px-1 pt-0.5 max-md:hidden text-[8.5px] font-extrabold uppercase leading-none tracking-wider text-zinc-400">
        Traffic
      </span>
      {TOOLS.map((t) => {
        const Icon = t.icon;
        return (
          <div key={t.id} className="group relative">
            <button
              type="button"
              onClick={() => setTool(t.id)}
              data-active={tool === t.id}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              className="icon-btn h-11 w-11 max-md:h-10 max-md:w-10"
            >
              <Icon className="h-5 w-5" />
            </button>
            <span className="pointer-events-none max-md:hidden absolute left-full top-1/2 ml-3 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2.5 py-1.5 text-[11px] font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100">
              <b>{t.label}</b> <kbd className="ml-1 rounded bg-white/15 px-1 text-[10px]">{t.key}</kbd>
              <span className="block text-[10px] font-normal text-white/70">{t.hint}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
