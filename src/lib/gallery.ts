"use client";

import type { NetworkSnapshot } from "@/sim/types";

/** Client side of the community gallery (see src/app/api/levels/route.ts). */

export interface GalleryEntry {
  id: string;
  name: string;
  from: string;
  /** Vehicles the unchanged city moved in five minutes, as measured in the author's browser. */
  baseline: number;
  at: number;
  likes: number;
  plays: number;
  roads: number;
}

export interface GalleryLevel {
  id: string;
  name: string;
  from: string;
  baseline: number;
  delayShare?: number;
  queueFt?: number;
  bus?: number;
  bike?: number;
  network: NetworkSnapshot;
}

const DEVICE_KEY = "road-constructor:device:v1";

/** A random id for this browser, so a like or a report counts once per device. It is not an account and says nothing about who you are. */
export function deviceId(): string {
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9]{12,40}$/.test(id)) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      id = Array.from(bytes).map((b) => (b % 36).toString(36)).join("") + Date.now().toString(36);
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "anonymousdevice00";
  }
}

async function call<T>(init: { body?: unknown; query?: string }): Promise<T | { error: string }> {
  try {
    const res = await fetch(`/api/levels${init.query ?? ""}`, init.body
      ? { method: "POST", headers: { "Content-Type": "application/json", "x-rc-device": deviceId() }, body: JSON.stringify(init.body), cache: "no-store" }
      : { cache: "no-store" });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) return { error: data.error ?? "The gallery isn't available right now" };
    return data;
  } catch {
    return { error: "Couldn't reach the gallery" };
  }
}

let enabledCache: boolean | null = null;

/** Whether this site has a gallery at all (it needs a Redis store configured): the game hides the feature when it doesn't. */
export async function galleryEnabled(): Promise<boolean> {
  if (enabledCache !== null) return enabledCache;
  const r = await call<{ enabled: boolean }>({ query: "?sort=new" });
  enabledCache = !("error" in r) && !!r.enabled;
  return enabledCache;
}

export async function listLevels(sort: "new" | "top", offset = 0): Promise<{ levels: GalleryEntry[]; more: boolean } | { error: string }> {
  const r = await call<{ enabled: boolean; levels: GalleryEntry[]; more: boolean }>({ query: `?sort=${sort}&offset=${offset}` });
  if ("error" in r) return r;
  if (!r.enabled) return { error: "The community gallery isn't switched on for this site" };
  return { levels: r.levels, more: r.more };
}

export async function fetchLevel(id: string): Promise<GalleryLevel | { error: string }> {
  const r = await call<{ level: GalleryLevel }>({ query: `?id=${encodeURIComponent(id)}` });
  return "error" in r ? r : r.level;
}

export async function publishLevel(input: { name: string; from: string; baseline: number; delayShare?: number; queueFt?: number; bus?: number; bike?: number; network: NetworkSnapshot }): Promise<{ id: string } | { error: string }> {
  const r = await call<{ id: string }>({ body: { action: "publish", ...input } });
  return "error" in r ? r : { id: r.id };
}

export async function likeLevel(id: string): Promise<number | { error: string }> {
  const r = await call<{ likes: number }>({ body: { action: "like", id } });
  return "error" in r ? r : r.likes;
}

export async function reportLevel(id: string): Promise<true | { error: string }> {
  const r = await call<object>({ body: { action: "report", id } });
  return "error" in r ? r : true;
}

export function notePlayed(id: string): void {
  void call<object>({ body: { action: "play", id } });
}
