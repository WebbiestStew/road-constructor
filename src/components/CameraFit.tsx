"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { subscribeFitView } from "@/lib/camera";

/** Zooms the orthographic camera so a network of the given radius fills the screen. Renders nothing. */
export default function CameraFit() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  useEffect(
    () =>
      subscribeFitView((radiusFt) => {
        if (!(camera instanceof THREE.OrthographicCamera)) return;
        // The default view is a steep oblique, so the ground foreshortens vertically; leave a margin for that and the HUD.
        const span = Math.max(radiusFt, 200) * 2 * 1.25;
        camera.zoom = THREE.MathUtils.clamp(Math.min(size.width, size.height * 1.25) / span, 0.08, 4);
        camera.updateProjectionMatrix();
      }),
    [camera, size.width, size.height]
  );

  return null;
}
