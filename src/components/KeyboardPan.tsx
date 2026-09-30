"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

const PAN_SPEED_FT_PER_S = 900; // at zoom 1; scaled by 1/zoom so the on-screen speed stays constant
const FAST_MULTIPLIER = 2.6;
const ROTATE_SPEED_RAD_PER_S = 1.1;

const PAN_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _offset = new THREE.Vector3();

/**
 * WASD / arrow keys pan the camera across the ground, Shift goes faster, and Q/E orbit. Moves the camera
 * and the orbit target together so mouse orbiting keeps working from the new spot. Renders nothing.
 */
export default function KeyboardPan() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const held = useRef(new Set<string>());

  useEffect(() => {
    const heldKeys = held.current;
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = e.key.toLowerCase();
      if (PAN_KEYS.has(k) || k === "q" || k === "e") {
        heldKeys.add(k);
        e.preventDefault();
      }
      if (e.key === "Shift") heldKeys.add("shift");
    };
    const up = (e: KeyboardEvent) => {
      heldKeys.delete(e.key.toLowerCase());
      if (e.key === "Shift") heldKeys.delete("shift");
    };
    const clear = () => heldKeys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useFrame((_, delta) => {
    const keys = held.current;
    if (keys.size === 0 || !controls) return;
    const dt = Math.min(delta, 0.1);

    // Ground-plane axes from where the camera is looking, so W is always "up the screen".
    camera.getWorldDirection(_forward);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-6) return;
    _forward.normalize();
    _right.crossVectors(_forward, camera.up).normalize();

    const zoom = camera instanceof THREE.OrthographicCamera ? camera.zoom : 1;
    const speed = (PAN_SPEED_FT_PER_S / zoom) * (keys.has("shift") ? FAST_MULTIPLIER : 1) * dt;

    let dx = 0;
    let dz = 0;
    if (keys.has("w") || keys.has("arrowup")) dz += 1;
    if (keys.has("s") || keys.has("arrowdown")) dz -= 1;
    if (keys.has("d") || keys.has("arrowright")) dx += 1;
    if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
    if (dx !== 0 || dz !== 0) {
      _offset.set(0, 0, 0).addScaledVector(_forward, dz * speed).addScaledVector(_right, dx * speed);
      camera.position.add(_offset);
      controls.target.add(_offset);
    }

    const spin = (keys.has("e") ? 1 : 0) - (keys.has("q") ? 1 : 0);
    if (spin !== 0) {
      _offset.copy(camera.position).sub(controls.target);
      _offset.applyAxisAngle(camera.up, spin * ROTATE_SPEED_RAD_PER_S * dt);
      camera.position.copy(controls.target).add(_offset);
      camera.lookAt(controls.target);
    }
    controls.update();
  });

  return null;
}
