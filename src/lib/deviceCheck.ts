"use client";

/**
 * True when the viewport has no fine pointer (mouse/trackpad) and is narrow
 * enough to be a phone — i.e. genuinely can't drive this app's keyboard +
 * multi-button-mouse controls, as opposed to a touchscreen laptop that also
 * has a trackpad (which still reports `any-pointer: fine`).
 */
export function isTouchOnlyNarrowViewport(): boolean {
  if (typeof window === "undefined") return false;
  const noFinePointer = !window.matchMedia("(any-pointer: fine)").matches;
  const narrow = window.innerWidth < 820;
  return noFinePointer && narrow;
}
