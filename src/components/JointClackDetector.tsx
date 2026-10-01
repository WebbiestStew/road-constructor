"use client";

import { useMemo, useRef, type RefObject, memo } from "react";
import { useFrame } from "@react-three/fiber";
import { assembleNetworkCached } from "@/sim/network";
import { computePierDescriptors } from "./roadGeometry";
import { useEditorStore } from "@/state/editorStore";
import { playExpansionJointClack } from "@/lib/sound";
import type { VehicleSnapshot } from "@/hooks/useTrafficSimulation";
import { MAX_VEHICLES } from "@/sim/types";

interface JointClackDetectorProps {
  snapshotRef: RefObject<VehicleSnapshot | null>;
}

/** How close (ft, in the XZ plane) a vehicle's center must pass to a joint to trigger its clack. */
const TRIGGER_RADIUS_SQ_FT = 5 * 5;
/** Minimum real seconds before the same vehicle instance slot can re-trigger, so one lingering near a joint (e.g. stopped in traffic) doesn't spam the sound. */
const RETRIGGER_COOLDOWN_S = 1.5;
/** Caps how many clacks can fire in a single frame, so a platoon crossing a joint together doesn't spike the audio. */
const MAX_CLACKS_PER_FRAME = 3;

/**
 * Plays a bridge expansion-joint clack whenever a simulated vehicle's world
 * position passes near one of the elevated network's joint locations (the
 * same points where `buildExpansionJoint` paints the joint lines, aligned
 * with each pier). Reads vehicle positions directly out of the instance
 * matrices already being handed to `VehicleRenderer` each tick, rather than
 * plumbing new per-vehicle state through the worker. No visual output.
 */
function JointClackDetector({ snapshotRef }: JointClackDetectorProps) {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const mode = useEditorStore((s) => s.mode);

  const jointPositions = useMemo(() => {
    if (mode !== "simulate") return [];
    const network = assembleNetworkCached(nodes, edges);
    const points: [number, number][] = [];
    for (const edge of network.edges) {
      if (!edge.isElevated) continue;
      for (const pier of computePierDescriptors(edge)) {
        points.push([pier.capPosition[0], pier.capPosition[2]]);
      }
    }
    return points;
  }, [nodes, edges, mode]);

  const cooldownRef = useRef<Float32Array>(new Float32Array(MAX_VEHICLES));

  useFrame((_state, delta) => {
    if (jointPositions.length === 0) return;
    const snapshot = snapshotRef.current;
    if (!snapshot) return;

    const cooldowns = cooldownRef.current;
    const matrices = snapshot.matrices;
    let clacksThisFrame = 0;

    for (let i = 0; i < snapshot.activeCount; i++) {
      if (cooldowns[i] > 0) {
        cooldowns[i] -= delta;
        continue;
      }
      const base = i * 16;
      const x = matrices[base + 12];
      const z = matrices[base + 14];
      for (const [jx, jz] of jointPositions) {
        const dx = x - jx;
        const dz = z - jz;
        if (dx * dx + dz * dz <= TRIGGER_RADIUS_SQ_FT) {
          playExpansionJointClack();
          cooldowns[i] = RETRIGGER_COOLDOWN_S;
          clacksThisFrame += 1;
          break;
        }
      }
      if (clacksThisFrame >= MAX_CLACKS_PER_FRAME) break;
    }
  });

  return null;
}

/** Memoized: the game page re-renders several times a second with live traffic stats, and none of this scene depends on them. */
export default memo(JointClackDetector);
