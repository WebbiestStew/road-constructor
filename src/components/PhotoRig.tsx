"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { registerCapture, registerGrabber, usePhotoMode, usePhotoTour } from "@/lib/photoMode";
import { useEditorStore } from "@/state/editorStore";
import { getPrefs } from "@/lib/prefs";

const ORBIT_RAD_PER_S = 0.07;
const _offset = new THREE.Vector3();
const _sph = new THREE.Spherical();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

const SEGMENT_S = 11;

/** Sets an orthographic camera's zoom (a module-level helper, so the camera object isn't "modified" inside the render closure). */
function applyZoom(cam: THREE.OrthographicCamera, zoom: number): void {
  cam.zoom = zoom;
  cam.updateProjectionMatrix();
}
const ease = (t: number) => t * t * (3 - 2 * t);

interface Shot {
  target: THREE.Vector3;
  zoom: number;
  /** Camera elevation: angle from straight down, radians. */
  phi: number;
  /** Total swing around the target during the shot, radians. */
  swing: number;
}

/**
 * Lives inside the Canvas. In photo mode it slowly orbits the camera around whatever it's looking at, and it
 * registers the "save this frame" action: render a fresh frame and, in the same task (so the drawing buffer is
 * still valid), hand the canvas to toBlob and download it. Renders nothing.
 */
export default function PhotoRig() {
  const photo = usePhotoMode();
  const tour = usePhotoTour();
  const shotRef = useRef<{ from: Shot; to: Shot; t: number; theta: number } | null>(null);
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

  // A new tour starts from wherever the camera is now.
  useEffect(() => {
    shotRef.current = null;
  }, [tour]);

  useFrame((_, delta) => {
    if (!photo || !controls || getPrefs().reducedMotion) return;
    if (tour) {
      const dt = Math.min(delta, 0.1);
      const cam = camera as THREE.OrthographicCamera;
      if (!shotRef.current) {
        _offset.copy(camera.position).sub(controls.target);
        _sph.setFromVector3(_offset);
        const here: Shot = { target: controls.target.clone(), zoom: cam.zoom, phi: _sph.phi, swing: 0 };
        shotRef.current = { from: here, to: nextShot(here), t: 0, theta: _sph.theta };
      }
      const s = shotRef.current;
      s.t += dt / SEGMENT_S;
      if (s.t >= 1) {
        s.from = { target: s.to.target.clone(), zoom: s.to.zoom, phi: s.to.phi, swing: 0 };
        s.to = nextShot(s.from);
        s.t = 0;
      }
      const k = ease(s.t);
      _from.copy(s.from.target);
      _to.copy(s.to.target);
      controls.target.lerpVectors(_from, _to, k);
      applyZoom(cam, s.from.zoom + (s.to.zoom - s.from.zoom) * k);
      s.theta += (s.to.swing / SEGMENT_S) * dt;
      _offset.copy(camera.position).sub(controls.target);
      _sph.setFromVector3(_offset);
      _sph.theta = s.theta;
      _sph.phi = s.from.phi + (s.to.phi - s.from.phi) * k;
      _offset.setFromSpherical(_sph);
      camera.position.copy(controls.target).add(_offset);
      camera.lookAt(controls.target);
      controls.update();
      return;
    }
    _offset.copy(camera.position).sub(controls.target);
    _offset.applyAxisAngle(camera.up, ORBIT_RAD_PER_S * Math.min(delta, 0.1));
    camera.position.copy(controls.target).add(_offset);
    camera.lookAt(controls.target);
    controls.update();
  });

  return null;
}

/**
 * The next shot of a tour. It alternates a wide establishing view of the whole network with a low, close swoop over a
 * random stretch of road, and always swings a little so the light and the traffic keep moving across the frame.
 */
function nextShot(prev: Shot): Shot {
  const { nodes, edges } = useEditorStore.getState();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wide = prev.zoom > 0.9 || edges.length === 0;
  if (!wide || edges.length === 0) {
    // wide: look at the middle of everything
    const c = new THREE.Vector3();
    for (const n of nodes) c.add(new THREE.Vector3(n.position[0], 0, n.position[2]));
    if (nodes.length) c.multiplyScalar(1 / nodes.length);
    return { target: c, zoom: 0.45 + Math.random() * 0.2, phi: 0.62 + Math.random() * 0.2, swing: (Math.random() < 0.5 ? -1 : 1) * 0.35 };
  }
  const e = edges[Math.floor(Math.random() * edges.length)];
  const a = byId.get(e.fromNodeId);
  const b = byId.get(e.toNodeId);
  const t = 0.3 + Math.random() * 0.4;
  const target = a && b ? new THREE.Vector3(a.position[0] + (b.position[0] - a.position[0]) * t, (a.position[1] + b.position[1]) / 2, a.position[2] + (b.position[2] - a.position[2]) * t) : new THREE.Vector3();
  return { target, zoom: 2.0 + Math.random() * 1.0, phi: 0.8 + Math.random() * 0.22, swing: (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.3) };
}
