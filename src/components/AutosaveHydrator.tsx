"use client";

import { useEffect } from "react";
import { useEditorStore } from "@/state/editorStore";

/**
 * Applies any autosaved network exactly once, from a client-only effect
 * after mount. The store's initial state is always the same hard defaults
 * (see editorStore.ts) so the server-rendered HTML and the client's first
 * render match exactly — reading localStorage any earlier than this (e.g.
 * at store-creation time) gives returning players a different budget/network
 * on the client than what was server-rendered, which is a React hydration
 * mismatch, not just a cosmetic flash. Mounted ahead of ShareLinkLoader so a
 * `#data=` share link (applied in a later effect) still wins over a local
 * autosave when both are present. No visual output.
 */
export default function AutosaveHydrator() {
  const hydrateAutosave = useEditorStore((s) => s.hydrateAutosave);

  useEffect(() => {
    hydrateAutosave();
    // Intentionally run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
