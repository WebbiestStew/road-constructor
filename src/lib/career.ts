"use client";

import { useSyncExternalStore } from "react";
import type { MedalId } from "./serviceReport";

/**
 * The career: what a player's runs add up to. Winning pays city funds (more for a better result than ever before, a
 * trickle for a replay so nobody farms one level), and funds fund the free-build city. Medals are kept per level, and
 * stars plus medals set the player's rank.
 */

const KEY = "road-constructor:career:v1";

export interface CareerState {
  /** Unspent city funds, in game dollars. */
  funds: number;
  /** Everything ever earned, for the lifetime line. */
  earned: number;
  /** Best medals per level id. */
  medals: Record<string, MedalId[]>;
  /** Wins recorded, including replays. */
  runs: number;
}

export const FUNDS_PER_NEW_STAR = 1000;
export const FUNDS_PER_NEW_MEDAL = 400;
export const FUNDS_PER_REPLAY = 100;
/** One funds-to-budget transfer moves at most this much, so the treasury is a bankroll and not a cheat code. */
export const MAX_TRANSFER = 500_000;

export const RANKS: { name: string; points: number }[] = [
  { name: "Intern", points: 0 },
  { name: "Technician", points: 6 },
  { name: "Engineer", points: 15 },
  { name: "Senior Engineer", points: 30 },
  { name: "Chief Engineer", points: 50 },
  { name: "Commissioner", points: 80 },
];

const EMPTY: CareerState = { funds: 0, earned: 0, medals: {}, runs: 0 };

let cache: CareerState | null = null;
const listeners = new Set<() => void>();

function read(): CareerState {
  if (cache) return cache;
  cache = EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<CareerState>;
      const medals: Record<string, MedalId[]> = {};
      if (p.medals && typeof p.medals === "object") {
        for (const [id, list] of Object.entries(p.medals)) if (Array.isArray(list)) medals[id] = list.filter((m): m is MedalId => typeof m === "string");
      }
      cache = {
        funds: Number.isFinite(p.funds) ? Math.max(0, Math.round(p.funds as number)) : 0,
        earned: Number.isFinite(p.earned) ? Math.max(0, Math.round(p.earned as number)) : 0,
        medals,
        runs: Number.isFinite(p.runs) ? Math.max(0, Math.round(p.runs as number)) : 0,
      };
    }
  } catch {
    // unreadable or unavailable: start fresh
  }
  return cache;
}

function write(next: CareerState) {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore: the career just won't persist
  }
  listeners.forEach((l) => l());
}

export interface RunPayout {
  funds: number;
  newStars: number;
  newMedals: number;
  /** Medal ids earned this run that the player had not held on this level before. */
  freshMedals: MedalId[];
}

/** What a win pays, given what the level had already given. Pure, so the results screen can preview it. */
export function payoutFor(opts: { stars: number; previousStars: number; earned: MedalId[]; previousMedals: MedalId[] }): RunPayout {
  const newStars = Math.max(0, opts.stars - opts.previousStars);
  const freshMedals = opts.earned.filter((m) => !opts.previousMedals.includes(m));
  const funds = newStars * FUNDS_PER_NEW_STAR + freshMedals.length * FUNDS_PER_NEW_MEDAL + FUNDS_PER_REPLAY;
  return { funds, newStars, newMedals: freshMedals.length, freshMedals };
}

/** Records a won run: pays out, and keeps the union of medals ever earned on the level. Daily and challenge levels pass `payFunds: false` for the stars (they have none) but still keep medals. */
export function recordRun(levelId: string, opts: { stars: number; previousStars: number; earned: MedalId[] }): RunPayout {
  const state = read();
  const previousMedals = state.medals[levelId] ?? [];
  const payout = payoutFor({ ...opts, previousMedals });
  const merged = Array.from(new Set([...previousMedals, ...opts.earned]));
  write({
    funds: state.funds + payout.funds,
    earned: state.earned + payout.funds,
    medals: { ...state.medals, [levelId]: merged },
    runs: state.runs + 1,
  });
  return payout;
}

/** Moves funds out of the treasury (into the free-build budget). Returns the amount actually moved. */
export function withdrawFunds(amount: number): number {
  const state = read();
  const take = Math.max(0, Math.min(Math.round(amount), state.funds, MAX_TRANSFER));
  if (take <= 0) return 0;
  write({ ...state, funds: state.funds - take });
  return take;
}

export function careerPoints(state: CareerState, totalStarCount: number): number {
  const medalCount = Object.values(state.medals).reduce((n, list) => n + list.length, 0);
  return totalStarCount + medalCount;
}

export function rankFor(points: number): { rank: (typeof RANKS)[number]; next: (typeof RANKS)[number] | null; index: number } {
  let index = 0;
  for (let i = 0; i < RANKS.length; i++) if (points >= RANKS[i].points) index = i;
  return { rank: RANKS[index], next: RANKS[index + 1] ?? null, index };
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useCareer(): CareerState {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

/** Imports a career from a save file (replaces the current one). */
export function replaceCareer(next: CareerState): void {
  write(next);
}

export function exportCareer(): CareerState {
  return read();
}
