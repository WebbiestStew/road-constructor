"use client";

import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { registerCapture, registerGrabber, usePhotoMode } from "@/lib/photoMode";
import { getPrefs } from "@/lib/prefs";

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

  useEffect(() => {
    registerGrabber({
      frame: () =>
        new Promise((resolve) => {
          // Render in the same task as toBlob so the drawing buffer is still valid.
          advance(performance.now() / 1000);
          gl.domElement.toBlob((b) => resolve(b), "image/png");
        }),
      clip: (seconds) =>
        new Promise((resolve) => {
          const canvas = gl.domElement;
          if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") return resolve(null);
          const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
          if (!type) return resolve(null);
          try {
            const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 5_000_000 });
            const chunks: Blob[] = [];
            recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
            recorder.onstop = () => resolve({ blob: new Blob(chunks, { type }), ext: type.startsWith("video/mp4") ? "mp4" : "webm" });
            recorder.onerror = () => resolve(null);
            recorder.start();
            window.setTimeout(() => recorder.state !== "inactive" && recorder.stop(), seconds * 1000);
          } catch {
            resolve(null);
          }
        }),
    });
    return () => registerGrabber(null);
  }, [advance, gl]);

  useFrame((_, delta) => {
    if (!photo || !controls || getPrefs().reducedMotion) return;
    _offset.copy(camera.position).sub(controls.target);
    _offset.applyAxisAngle(camera.up, ORBIT_RAD_PER_S * Math.min(delta, 0.1));
    camera.position.copy(controls.target).add(_offset);
    camera.lookAt(controls.target);
    controls.update();
  });

  return null;
}
