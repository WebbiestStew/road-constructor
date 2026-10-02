import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { VehicleKind } from "@/sim/types";

/**
 * The shape of each kind of road user, in feet, standing on the ground (y = 0) with its front toward +z and centred on
 * its own middle. Parts carry vertex colours: white where the body paint should show (it is multiplied by each vehicle's
 * own paint colour), near-black for glass and tyres, so one tint per vehicle paints only the bodywork.
 */

type RGB = [number, number, number];
const PAINT: RGB = [1, 1, 1];
const GLASS: RGB = [0.1, 0.14, 0.2];
const TIRE: RGB = [0.04, 0.04, 0.05];
const DARK: RGB = [0.14, 0.14, 0.16];
const SKIN: RGB = [0.88, 0.7, 0.6];

/** Real-world size of each kind, used for its box fallback and for placing lights and its shadow. */
export const KIND_DIMS: Record<VehicleKind, { w: number; h: number; l: number }> = {
  car: { w: 6.2, h: 4.7, l: 15 },
  truck: { w: 8.4, h: 11, l: 37 },
  bus: { w: 8.2, h: 10.6, l: 40 },
  bike: { w: 1.6, h: 6.8, l: 6 },
  ambulance: { w: 7, h: 8.4, l: 21 },
};

interface PartOptions {
  /** Colour of the top face; defaults to the side colour. */
  top?: RGB;
  /** Fraction the top edge is pulled in, so a cabin tapers toward the roof. */
  taper?: number;
}

function paint(g: THREE.BufferGeometry, rgb: (nx: number, ny: number, nz: number) => RGB): THREE.BufferGeometry {
  const n = g.getAttribute("normal");
  const colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const c = rgb(n.getX(i), n.getY(i), n.getZ(i));
    colors.set(c, i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

function box(w: number, h: number, l: number, x: number, y: number, z: number, side: RGB, opts: PartOptions = {}): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, l);
  if (opts.taper) {
    const pos = g.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        pos.setX(i, pos.getX(i) * (1 - opts.taper));
        pos.setZ(i, pos.getZ(i) * (1 - opts.taper * 0.6));
      }
    }
    g.computeVertexNormals();
  }
  g.translate(x, y + h / 2, z);
  const top = opts.top ?? side;
  return paint(g, (nx, ny) => (ny > 0.6 ? top : ny < -0.6 ? DARK : side));
}

function wheel(r: number, width: number, x: number, z: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, width, 12);
  g.rotateZ(Math.PI / 2);
  g.translate(x, r, z);
  return paint(g, () => TIRE);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // mergeGeometries needs every part indexed the same way
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const merged = mergeGeometries(flat, false);
  return merged ?? flat[0];
}

function car(): THREE.BufferGeometry {
  return merge([
    box(6.2, 2.1, 15, 0, 1.0, 0, PAINT),
    box(5.5, 1.7, 8.4, 0, 3.1, -0.9, GLASS, { top: PAINT, taper: 0.1 }),
    box(6.25, 0.5, 1.2, 0, 1.0, 7.3, DARK),
    box(6.25, 0.5, 1.2, 0, 1.0, -7.3, DARK),
    wheel(1.15, 0.9, 3.0, 4.7),
    wheel(1.15, 0.9, -3.0, 4.7),
    wheel(1.15, 0.9, 3.0, -4.6),
    wheel(1.15, 0.9, -3.0, -4.6),
  ]);
}

function truck(): THREE.BufferGeometry {
  return merge([
    box(7, 1.1, 34, 0, 1.3, 0, DARK),
    box(8.2, 8.2, 7.6, 0, 2.4, 14.4, PAINT),
    box(7.5, 2.8, 0.3, 0, 6.6, 18.3, GLASS),
    box(8.4, 9.6, 26.5, 0, 2.4, -5.2, PAINT),
    wheel(1.7, 1.2, 3.6, 15),
    wheel(1.7, 1.2, -3.6, 15),
    wheel(1.7, 1.2, 3.6, -9),
    wheel(1.7, 1.2, -3.6, -9),
    wheel(1.7, 1.2, 3.6, -13.2),
    wheel(1.7, 1.2, -3.6, -13.2),
  ]);
}

function bus(): THREE.BufferGeometry {
  return merge([
    box(8.2, 9.4, 39, 0, 1.6, 0, PAINT),
    box(8.3, 3.2, 31, 0, 6.0, -1.5, GLASS, { top: GLASS }),
    box(7.6, 3.4, 0.3, 0, 5.9, 19.6, GLASS),
    wheel(1.7, 1.2, 3.9, 12.5),
    wheel(1.7, 1.2, -3.9, 12.5),
    wheel(1.7, 1.2, 3.9, -12),
    wheel(1.7, 1.2, -3.9, -12),
  ]);
}

function ambulance(): THREE.BufferGeometry {
  return merge([
    box(7, 6.6, 14, 0, 1.6, -3.4, PAINT),
    box(7, 3.4, 6.8, 0, 1.6, 6.8, PAINT),
    box(6.2, 2.4, 0.3, 0, 4.4, 10.3, GLASS),
    box(7.1, 0.9, 12.5, 0, 3.4, -3.4, [0.85, 0.12, 0.12]),
    box(2.4, 0.7, 1.5, 1.4, 8.2, 2.6, [1, 0.2, 0.2]),
    box(2.4, 0.7, 1.5, -1.4, 8.2, 2.6, [0.2, 0.35, 1]),
    wheel(1.5, 1.0, 3.2, 6.5),
    wheel(1.5, 1.0, -3.2, 6.5),
    wheel(1.5, 1.0, 3.2, -6.5),
    wheel(1.5, 1.0, -3.2, -6.5),
  ]);
}

function bike(): THREE.BufferGeometry {
  return merge([
    wheel(1.4, 0.5, 0, 2.2),
    wheel(1.4, 0.5, 0, -2.2),
    box(0.45, 0.45, 4.6, 0, 2.2, 0, DARK),
    box(1.5, 2.8, 1.3, 0, 3.4, -0.4, PAINT),
    box(1.1, 1.1, 1.1, 0, 6.2, 0.1, SKIN),
  ]);
}

const DETAILED: Record<VehicleKind, () => THREE.BufferGeometry> = { car, truck, bus, bike, ambulance };

/** Plain box fallback: same footprint and height, no detail. */
function plain(kind: VehicleKind): THREE.BufferGeometry {
  const d = KIND_DIMS[kind];
  const g = new THREE.BoxGeometry(d.w, d.h, d.l);
  g.translate(0, d.h / 2, 0);
  return paint(g, () => PAINT);
}

const cache = new Map<string, THREE.BufferGeometry>();

/** The shape for a kind, built once and shared. */
export function vehicleGeometry(kind: VehicleKind, detailed: boolean): THREE.BufferGeometry {
  const key = `${kind}:${detailed}`;
  let g = cache.get(key);
  if (!g) {
    g = detailed ? DETAILED[kind]() : plain(kind);
    cache.set(key, g);
  }
  return g;
}
