"use client";

import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { registerCapture, usePhotoMode } from "@/lib/photoMode";

const ORBIT_RAD_PER_S = 0.07;
const _offset = new THREE.Vector3();

/**
 * Lives inside the Canvas. In photo mode it slowly orbits the camera around whatever it's looking at, and it
 * registers the "save this frame" action: render a fresh frame and, in the same task (so the drawing buffer is
 * still valid), hand the canvas to toBlob and download it. Renders nothing.
 */
export default function PhotoRig() {
  const photo = usePhotoMode();
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const advance = useThree((s) => s.advance);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;

  useEffect(() => {
    registerCapture(() => {
      advance(performance.now() / 1000);
      gl.domElement.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `road-constructor-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, "image/png");
    });
    return () => registerCapture(null);
  }, [advance, gl]);

  useFrame((_, delta) => {
    if (!photo || !controls) return;
    _offset.copy(camera.position).sub(controls.target);
    _offset.applyAxisAngle(camera.up, ORBIT_RAD_PER_S * Math.min(delta, 0.1));
    camera.position.copy(controls.target).add(_offset);
    camera.lookAt(controls.target);
    controls.update();
  });

  return null;
}
