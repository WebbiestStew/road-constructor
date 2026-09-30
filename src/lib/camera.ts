"use client";

/** Lets UI outside the Canvas ask the 3D camera to frame the whole network (e.g. when a city loads). */

const listeners = new Set<(radiusFt: number) => void>();

export function requestFitView(radiusFt: number): void {
  listeners.forEach((l) => l(radiusFt));
}

export function subscribeFitView(cb: (radiusFt: number) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Distance from the origin to the farthest node — the radius a fitted view must cover. */
export function networkRadiusFt(nodes: { position: [number, number, number] }[]): number {
  let r = 0;
  for (const n of nodes) r = Math.max(r, Math.hypot(n.position[0], n.position[2]));
  return r;
}
