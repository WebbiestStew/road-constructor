"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/state/editorStore";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { downloadNetworkFile, parseNetworkFile } from "@/state/persistence";
import { isMuted, subscribeMuted, toggleMuted } from "@/lib/sound";
import { requestOpenTutorial } from "@/lib/tutorial";
import {
  IconDownload,
  IconHeatmap,
  IconHelp,
  IconRedo,
  IconRoad,
  IconSpeakerOff,
  IconSpeakerOn,
  IconUndo,
  IconUpload,
} from "./icons";

const SPEED_OPTIONS = [1, 2, 5, 10];

export default function TopBar({ sim }: { sim: UseTrafficSimulationReturn }) {
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const heatmapEnabled = useEditorStore((s) => s.heatmapEnabled);
  const setHeatmapEnabled = useEditorStore((s) => s.setHeatmapEnabled);
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMutedState(isMuted()));
    const unsubscribe = subscribeMuted(setMutedState);
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, []);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const exportPayload = useEditorStore((s) => s.exportPayload);
  const importPayload = useEditorStore((s) => s.importPayload);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { speedMultiplier, setSpeedMultiplier } = sim;

  const handleImportFile = async (file: File) => {
    const text = await file.text();
    const payload = parseNetworkFile(text);
    if (!payload) {
      window.alert("That file doesn't look like a valid Road Constructor network export.");
      return;
    }
    importPayload(payload);
  };

  return (
    <div className="pointer-events-auto absolute left-4 top-4 z-20 flex items-center gap-1 rounded-full p-1.5 hud-panel">
      <div className="flex items-center gap-1.5 pl-1.5 pr-2.5">
        <span className="hover-wiggle flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-white shadow-sm">
          <IconRoad className="h-4 w-4" />
        </span>
        <span className="font-display hidden text-base font-extrabold tracking-tight text-[#241b3d] sm:inline">
          Road Constructor
        </span>
      </div>

      <div className="h-6 w-px bg-black/10" />

      <div className="flex items-center gap-1 rounded-full bg-black/5 p-1">
        <button
          type="button"
          onClick={() => setMode("build")}
          className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
            mode === "build"
              ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          Build
        </button>
        <button
          type="button"
          onClick={() => setMode("simulate")}
          className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
            mode === "simulate"
              ? "bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          Open to Traffic 🚦
        </button>
      </div>

      {mode === "build" && (
        <>
          <div className="h-6 w-px bg-black/10" />
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <IconUndo className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <IconRedo className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="h-6 w-px bg-black/10" />
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => downloadNetworkFile(exportPayload())}
              title="Export network to a file"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
            >
              <IconDownload className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Import network from a file"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
            >
              <IconUpload className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = "";
              }}
            />
          </div>
        </>
      )}

      {mode === "simulate" && (
        <>
          <div className="h-6 w-px bg-black/10" />
          <div className="flex items-center gap-0.5 rounded-full bg-black/5 p-1">
            {SPEED_OPTIONS.map((mult) => (
              <button
                key={mult}
                type="button"
                onClick={() => setSpeedMultiplier(mult)}
                className={`rounded-full px-2.5 py-1.5 text-[11px] font-bold tabular-nums transition ${
                  speedMultiplier === mult
                    ? "bg-gradient-to-br from-sky-400 to-blue-500 text-white"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {mult}×
              </button>
            ))}
          </div>
          <div className="h-6 w-px bg-black/10" />
          <button
            type="button"
            onClick={() => setHeatmapEnabled(!heatmapEnabled)}
            title="Toggle traffic speed heatmap"
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition ${
              heatmapEnabled
                ? "bg-gradient-to-br from-rose-400 to-orange-500 text-white shadow"
                : "bg-black/5 text-zinc-600 hover:text-zinc-900"
            }`}
          >
            <IconHeatmap className="h-3.5 w-3.5" />
            Heatmap
          </button>
        </>
      )}

      <div className="h-6 w-px bg-black/10" />
      <button
        type="button"
        onClick={toggleMuted}
        title={muted ? "Unmute sound" : "Mute sound"}
        className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
      >
        {muted ? <IconSpeakerOff className="h-3.5 w-3.5" /> : <IconSpeakerOn className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={requestOpenTutorial}
        title="How to play"
        className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 transition hover:bg-black/5 hover:text-zinc-900"
      >
        <IconHelp className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
