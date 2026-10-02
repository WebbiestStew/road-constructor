"use client";

import { useEditorStore } from "@/state/editorStore";
import { useState } from "react";
import { recordClip, setPhotoMode, takePhoto } from "@/lib/photoMode";
import { shareOrDownload } from "@/lib/shareCard";
import { pushToast } from "@/lib/toast";

/** The only UI left in photo mode: pick a light, save the frame, or leave. */
export default function PhotoOverlay() {
  const timeOfDay = useEditorStore((s) => s.timeOfDay);
  const setTimeOfDay = useEditorStore((s) => s.setTimeOfDay);
  const [recording, setRecording] = useState(false);

  const clip = async () => {
    setRecording(true);
    pushToast("🎥 Recording 8 seconds…", "info");
    const result = await recordClip(8);
    setRecording(false);
    if (!result) {
      pushToast("This browser can't record clips. Try Chrome or Edge", "bad");
      return;
    }
    const how = await shareOrDownload(result.blob, `road-constructor-${Date.now()}.${result.ext}`, "My city in Road Constructor");
    pushToast(how === "shared" ? "🎥 Clip shared" : "🎥 Clip saved to your downloads", "good");
  };

  return (
    <div className="pointer-events-auto absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full px-2.5 py-2 hud-panel">
      <div className="flex items-center gap-0.5 rounded-full bg-black/5 p-1">
        {(["day", "dusk", "night"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTimeOfDay(t)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold capitalize transition ${
              timeOfDay === t ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow" : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            {t === "day" ? "☀️" : t === "dusk" ? "🌆" : "🌙"} {t}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          takePhoto();
          pushToast("📸 Saved to your downloads", "good");
        }}
        className="chunky-btn bg-gradient-to-br from-orange-400 to-pink-500 px-5 py-2 text-sm text-white"
      >
        📸 Save photo
      </button>
      <button
        type="button"
        disabled={recording}
        onClick={() => void clip()}
        className="rounded-full bg-black/5 px-3.5 py-2 text-xs font-bold text-zinc-700 transition hover:bg-black/10 active:scale-95 disabled:opacity-50"
      >
        {recording ? "🔴 Recording…" : "🎥 8 s clip"}
      </button>
      <button
        type="button"
        onClick={() => setPhotoMode(false)}
        className="rounded-full px-3 py-1.5 text-xs font-bold text-zinc-600 hover:bg-black/5 hover:text-zinc-900"
      >
        Exit (H)
      </button>
    </div>
  );
}
