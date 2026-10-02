"use client";

import { useSyncExternalStore } from "react";
import { z } from "zod";
import { decodeJsonFromHash, encodeJsonToHash, isValidNetwork } from "@/state/persistence";
import type { NetworkSnapshot } from "@/sim/types";

/**
 * "Beat my score" links. A link carries either a campaign/daily level (just its id) or a whole custom city, plus the
 * score to beat and who set it. No server: the whole challenge is in the URL hash.
 */

export const CHALLENGE_HASH_PREFIX = "#challenge=";

const headSchema = z.object({ v: z.literal(1), from: z.string().max(24), target: z.number().min(0).max(100000) });
const levelSchema = headSchema.extend({ kind: z.literal("level"), id: z.string().max(80) });
const customSchema = headSchema.extend({ kind: z.literal("custom"), name: z.string().max(40) });

export type ChallengePayload =
  | { kind: "level"; id: string; from: string; target: number }
  | { kind: "custom"; name: string; network: NetworkSnapshot; from: string; target: number };

export async function encodeChallenge(p: ChallengePayload): Promise<string> {
  const body = p.kind === "level" ? { v: 1, kind: "level", id: p.id, from: p.from, target: p.target } : { v: 1, kind: "custom", name: p.name, network: p.network, from: p.from, target: p.target };
  return `${window.location.origin}/play${CHALLENGE_HASH_PREFIX}${await encodeJsonToHash(body)}`;
}

export async function decodeChallenge(hash: string): Promise<ChallengePayload | null> {
  const raw = await decodeJsonFromHash(hash);
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "level") {
    const r = levelSchema.safeParse(raw);
    return r.success ? { kind: "level", id: r.data.id, from: r.data.from, target: r.data.target } : null;
  }
  if (kind === "custom") {
    const r = customSchema.safeParse(raw);
    const network = (raw as { network?: unknown }).network;
    if (!r.success || !isValidNetwork(network)) return null;
    return { kind: "custom", name: r.data.name, network, from: r.data.from, target: r.data.target };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The challenge the player is currently attempting (if any), so the results screen can say whether they beat it.
// ---------------------------------------------------------------------------

export interface ActiveChallenge {
  scenarioId: string;
  from: string;
  target: number;
}

let active: ActiveChallenge | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setActiveChallenge(c: ActiveChallenge | null): void {
  active = c;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useActiveChallenge(): ActiveChallenge | null {
  return useSyncExternalStore(
    subscribe,
    () => active,
    () => null
  );
}

// ---------------------------------------------------------------------------
// "Make a challenge from my city": the top bar asks, and the loader (which can start a level) answers.
// ---------------------------------------------------------------------------

const makeListeners = new Set<() => void>();

export function requestMakeChallenge(): void {
  makeListeners.forEach((l) => l());
}

export function onMakeChallenge(cb: () => void): () => void {
  makeListeners.add(cb);
  return () => {
    makeListeners.delete(cb);
  };
}

const NAME_KEY = "road-constructor:player-name:v1";

/** The name challenges are sent under: the leaderboard name if the player has set one, else a friendly default. */
export function challengerName(): string {
  try {
    const n = window.localStorage.getItem(NAME_KEY)?.trim();
    if (n) return n.slice(0, 24);
  } catch {
    // ignore
  }
  return "A friend";
}
