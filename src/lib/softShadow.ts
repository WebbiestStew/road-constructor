import * as THREE from "three";

let texture: THREE.CanvasTexture | null = null;

/**
 * A soft dark blob (opaque black at the middle, fading to nothing at the edge) used as a fake contact shadow: a flat
 * quad under each car and at the foot of each bridge pier, so nothing seems to float above the ground.
 */
export function softShadowTexture(): THREE.CanvasTexture {
  if (texture) return texture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(0,0,0,0.95)");
  grad.addColorStop(0.45, "rgba(0,0,0,0.7)");
  grad.addColorStop(0.8, "rgba(0,0,0,0.18)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  texture = new THREE.CanvasTexture(canvas);
  return texture;
}
