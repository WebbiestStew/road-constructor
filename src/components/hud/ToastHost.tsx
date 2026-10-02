"use client";

import { useToast, type ToastTone } from "@/lib/toast";

const TONE_STYLE: Record<ToastTone, string> = {
  good: "from-emerald-400 to-teal-500 text-white",
  bad: "from-rose-400 to-red-500 text-white",
  alert: "from-amber-400 to-orange-500 text-white",
  info: "from-violet-500 to-fuchsia-600 text-white",
};

/** Shows the latest game-feel toast ("Nice! +5 mph", "Breakdown!") just under the top bar. */
export default function ToastHost() {
  const toast = useToast();
  if (!toast) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-28 z-[60] -translate-x-1/2 max-md:top-[7.5rem] lg:top-24">
      {/* keyed by id so each new toast replays its pop-in */}
      <div
        key={toast.id}
        className={`animate-pop max-w-[90vw] rounded-full border-2 border-[#2b1c40] bg-gradient-to-br px-5 py-2.5 text-center text-sm font-extrabold shadow-[0_4px_0_#2b1c40] ${TONE_STYLE[toast.tone]}`}
      >
        {toast.text}
      </div>
    </div>
  );
}
