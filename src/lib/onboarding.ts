"use client";

/** Tracks whether the first-run 3-step onboarding checklist has been completed or dismissed. */

const SEEN_KEY = "road-constructor:onboarding-seen:v1";

export function hasSeenOnboarding(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markOnboardingSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // ignore
  }
}
