"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";

/**
 * Labels that follow a point in the 3D scene (zone badges, warning markers, the drag cost tag).
 *
 * drei's <Html> gives every label its own React root and tears it down in a layout-effect cleanup. React 19 does not
 * allow that while it is still committing, and when a level changes (or finishes) dozens of labels unmount at once and
 * the page throws "removeChild: the node to be removed is not a child". These labels are ordinary DOM instead:
 * <WorldLabel> sits in the 3D scene and only registers itself in a small store, <WorldLabelLayer> renders every
 * label as a normal React child outside the canvas, and <WorldLabelProjector> moves them to the right pixel each frame.
 */

interface LabelEntry {
  id: number;
  object: THREE.Object3D;
  node: ReactNode;
  center: boolean;
  zIndex: number;
  hidden: boolean;
}

let nextId = 1;
let entries: LabelEntry[] = [];
const listeners = new Set<() => void>();
const elements = new Map<number, HTMLDivElement>();
const EMPTY: LabelEntry[] = [];

// Dozens of labels register in the same commit; telling the layer once per batch keeps React from counting each as a
// nested update ("maximum update depth exceeded").
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => {
    emitQueued = false;
    listeners.forEach((l) => l());
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function upsert(entry: LabelEntry) {
  const i = entries.findIndex((e) => e.id === entry.id);
  entries = i < 0 ? [...entries, entry] : entries.map((e, k) => (k === i ? entry : e));
  emit();
}

function remove(id: number) {
  if (!entries.some((e) => e.id === id)) return;
  entries = entries.filter((e) => e.id !== id);
  elements.delete(id);
  emit();
}

function registerElement(id: number, el: HTMLDivElement | null) {
  if (el) elements.set(id, el);
  else elements.delete(id);
}

const scratch = new THREE.Vector3();
let lastView: { camera: THREE.Camera; width: number; height: number } | null = null;

/** Puts each label at the screen position of its anchor. A plain function, so the per-frame DOM writes stay out of React's rules. */
function projectLabels(camera: THREE.Camera, width: number, height: number) {
  for (const entry of entries) {
    const el = elements.get(entry.id);
    if (!el) continue;
    let hidden = entry.hidden;
    for (let o: THREE.Object3D | null = entry.object; o && !hidden; o = o.parent) if (!o.visible) hidden = true;
    if (hidden) {
      el.style.display = "none";
      continue;
    }
    entry.object.getWorldPosition(scratch);
    scratch.project(camera);
    if (scratch.z > 1 || scratch.z < -1 || Math.abs(scratch.x) > 1.2 || Math.abs(scratch.y) > 1.2) {
      el.style.display = "none";
      continue;
    }
    const x = (scratch.x * 0.5 + 0.5) * width;
    const y = (-scratch.y * 0.5 + 0.5) * height;
    el.style.display = "";
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)${entry.center ? " translate(-50%, -50%)" : ""}`;
  }
}

/** Use inside the Canvas where an <Html> would have gone. `position` is where the label's anchor point sits in the scene. */
export function WorldLabel({
  children,
  position,
  center = false,
  zIndex = 10,
  hidden = false,
}: {
  children: ReactNode;
  position?: [number, number, number];
  center?: boolean;
  zIndex?: number;
  hidden?: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const idRef = useRef(0);

  useEffect(() => {
    const id = nextId++;
    idRef.current = id;
    return () => remove(id);
  }, []);

  // Every render, so the label's content stays current.
  useEffect(() => {
    const object = group.current;
    if (!object || idRef.current === 0) return;
    upsert({ id: idRef.current, object, node: children, center, zIndex, hidden });
  });

  return <group ref={group} position={position} />;
}

/** Renders every label, outside the Canvas. Put it next to the Canvas, in an element the canvas fills. */
export function WorldLabelLayer() {
  const list = useSyncExternalStore(
    subscribe,
    () => entries,
    () => EMPTY
  );
  // New or changed labels are placed straight away rather than waiting for the next rendered frame.
  useEffect(() => {
    if (lastView) projectLabels(lastView.camera, lastView.width, lastView.height);
  });
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      {list.map((entry) => (
        <div
          key={entry.id}
          ref={(el) => registerElement(entry.id, el)}
          style={{ position: "absolute", left: 0, top: 0, display: "none", zIndex: entry.zIndex, pointerEvents: "none", willChange: "transform" }}
        >
          {entry.node}
        </div>
      ))}
    </div>
  );
}

/** Inside the Canvas: moves the labels each rendered frame. */
export function WorldLabelProjector() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useFrame(() => {
    lastView = { camera, width: size.width, height: size.height };
    projectLabels(camera, size.width, size.height);
  });
  return null;
}
