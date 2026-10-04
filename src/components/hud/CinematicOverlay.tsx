"use client";

import { useState } from "react";
import { useEditorStore } from "@/state/editorStore";
import { stopFlyover, type FlyoverInfo } from "@/lib/cinematic";
import { recordClip } from "@/lib/photoMode";
import { shareOrDownload } from "@/lib/shareCard";
import { pushToast } from "@/lib/toast";

const CLIP_S = 15;

/** The flyover's only UI: what it celebrates, a clip to save, a link to send, and the way back. */
export default function CinematicOverlay({ info }: { info: FlyoverInfo }) {
  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  const [recording, setRecording] = useState(false);

  const clip = async () => {
    setRecording(true);
    pushToast(`🎥 Recording ${CLIP_S} seconds…`, "info");
    const result = await recordClip(CLIP_S);
    setRecording(false);
    if (!result) {
      pushToast("This browser can't record clips. Try Chrome or Edge", "bad");
      return;
    }
    const how = await shareOrDownload(result.blob, `road-constructor-flyover-${Date.now()}.${result.ext}`, `${info.name} in Road Constructor`);
    pushToast(how === "shared" ? "🎥 Flyover shared" : "🎥 Flyover saved to your downloads", "good");
  };

  const link = async () => {
    const stars = `${"★".repeat(info.stars)}${"☆".repeat(3 - info.stars)}`;
    let url = `${window.location.origin}/play`;
    if (info.makeLink) {
      try {
        url = await info.makeLink();
      } catch {
        // fall back to the plain game link
      }
    }
    const text = `🚦 ${info.name} ${stars}\n${info.summary}\n${info.makeLink ? "Think you can beat it? " : "Play it: "}${url}`;
    try {
      await navigator.clipboard.writeText(text);
      pushToast("🔗 Link copied. Paste it to a friend", "good");
    } catch {
      window.prompt("Copy this link:", text);
    }
  };

  return (
    <>
      <div className="pointer-events-none absolute left-1/2 top-6 z-30 -translate-x-1/2 text-center">
        <div className="font-display text-[11px] font-extrabold uppercase tracking-[0.3em] text-white/70 drop-shadow">{timeOfDay === "night" ? "Night" : "Dusk"} flyover</div>
        <div className="font-display text-2xl font-black uppercase text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">{info.name}</div>
        <div className="mt-0.5 text-lg text-amber-300 drop-shadow">{"★".repeat(info.stars)}<span className="text-white/30">{"★".repeat(3 - info.stars)}</span></div>
      </div>
      <div className="pointer-events-auto absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full px-2.5 py-2 hud-panel">
        <button
          type="button"
          disabled={recording}
          onClick={() => void clip()}
          className="chunky-btn bg-gradient-to-br from-orange-400 to-pink-500 px-5 py-2 text-sm text-white disabled:opacity-60"
        >
          {recording ? "🔴 Recording…" : `🎥 Save ${CLIP_S} s clip`}
        </button>
        <button
          type="button"
          onClick={() => void link()}
          className="rounded-full bg-black/5 px-3.5 py-2 text-xs font-bold text-zinc-700 transition hover:bg-black/10 active:scale-95"
        >
          🔗 Copy link
        </button>
        <button
          type="button"
          onClick={stopFlyover}
          className="rounded-full px-3 py-1.5 text-xs font-bold text-zinc-600 hover:bg-black/5 hover:text-zinc-900"
        >
          Exit (Esc)
        </button>
      </div>
    </>
  );
}
