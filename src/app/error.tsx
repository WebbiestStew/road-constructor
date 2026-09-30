"use client";

import { useEffect } from "react";
import FallbackScreen from "@/components/FallbackScreen";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <FallbackScreen title="The city hit a pothole" actionLabel="Try again" onAction={retry}>
      <p>Something crashed. Your network is autosaved, so reloading shouldn&apos;t lose your work.</p>
      <p className="mt-2 text-xs text-zinc-500">This is a beta — if it keeps happening, please send feedback.</p>
    </FallbackScreen>
  );
}
