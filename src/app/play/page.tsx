"use client";

import dynamic from "next/dynamic";

// The game reads saved state from localStorage at load, so it only ever renders in the browser.
const PlayApp = dynamic(() => import("@/components/PlayApp"), { ssr: false });

export default function PlayPage() {
  return <PlayApp />;
}
