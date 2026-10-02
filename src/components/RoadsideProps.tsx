"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { assembleCached } from "@/sim/assembleCache";
import { useEditorStore } from "@/state/editorStore";

const MAX_PARKED = 700;
const MAX_STOPS = 120;
const PARKED_COLORS = ["#f4f4f5", "#1c1c22", "#8a8f98", "#b0281c", "#2452a6", "#2f6b3a", "#c9a13b", "#5b5f66"];
const BUS_STOP_AT = 0.6;
/** Distance from the kerb-side lane edge to where a shelter or parked car stands. */
const SHELTER_OFFSET_FT = 9;
const PARKED_OFFSET_FT = 4.2;
const PARKED_SPACING_FT = 22;

const UP = new THREE.Vector3(0, 1, 0);

/** A cheap repeatable 0-1 hash, so the same parking spaces are full every time the road is rebuilt. */
function hash01(seed: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Things that stand beside the road: bus shelters at bus stops, and parked cars along streets with parking.
 * Built from the editor's roads, so they appear the moment the player places them. Purely visual.
 */
function RoadsideProps() {
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const roofRef = useRef<THREE.InstancedMesh>(null);
  const panelRef = useRef<THREE.InstancedMesh>(null);
  const parkedRef = useRef<THREE.InstancedMesh>(null);

  const props = useMemo(() => {
    const anyProps = edges.some((e) => e.busStop || e.parking);
    if (!anyProps) return { stops: [] as THREE.Matrix4[], parked: [] as { m: THREE.Matrix4; color: string }[] };
    const net = assembleCached(nodes, edges);
    const _p = new THREE.Vector3();
    const _t = new THREE.Vector3();
    const _r = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(1, 1, 1);
    const stops: THREE.Matrix4[] = [];
    const parked: { m: THREE.Matrix4; color: string }[] = [];
    for (const e of net.edges) {
      if (e.busStop && stops.length < MAX_STOPS) {
        e.spline.getPointAt(BUS_STOP_AT, _p);
        e.spline.getTangentAt(BUS_STOP_AT, _t);
        _r.crossVectors(_t, UP).normalize();
        const lateral = e.lateralShiftFt + (e.lanes * e.laneWidthFt) / 2 + SHELTER_OFFSET_FT;
        _p.addScaledVector(_r, lateral);
        _q.setFromAxisAngle(UP, Math.atan2(_t.x, _t.z));
        stops.push(new THREE.Matrix4().compose(_p.clone(), _q.clone(), _s.clone()));
      }
      if (e.parking) {
        for (let d = 24; d < e.length - 24 && parked.length < MAX_PARKED; d += PARKED_SPACING_FT) {
          if (hash01(e.id, Math.round(d)) < 0.35) continue; // an empty space
          const t = d / e.length;
          e.spline.getPointAt(t, _p);
          e.spline.getTangentAt(t, _t);
          _r.crossVectors(_t, UP).normalize();
          _p.addScaledVector(_r, e.lateralShiftFt + (e.lanes * e.laneWidthFt) / 2 + PARKED_OFFSET_FT);
          _p.y += 2.25;
          _q.setFromAxisAngle(UP, Math.atan2(_t.x, _t.z));
          const color = PARKED_COLORS[Math.floor(hash01(e.id, Math.round(d) + 7) * PARKED_COLORS.length)];
          parked.push({ m: new THREE.Matrix4().compose(_p.clone(), _q.clone(), _s.clone()), color });
        }
      }
    }
    return { stops, parked };
  }, [nodes, edges]);

  useEffect(() => {
    const roof = roofRef.current;
    const panel = panelRef.current;
    const parked = parkedRef.current;
    if (!roof || !panel || !parked) return;
    const _m = new THREE.Matrix4();
    const _c = new THREE.Color();
    props.stops.forEach((m, i) => {
      // The roof and back panel share the stop's frame; each is offset in its own local space.
      _m.copy(m).multiply(new THREE.Matrix4().makeTranslation(0, 8.6, 0));
      roof.setMatrixAt(i, _m);
      _m.copy(m).multiply(new THREE.Matrix4().makeTranslation(2.4, 4.3, 0));
      panel.setMatrixAt(i, _m);
    });
    roof.count = props.stops.length;
    panel.count = props.stops.length;
    roof.instanceMatrix.needsUpdate = true;
    panel.instanceMatrix.needsUpdate = true;
    props.parked.forEach((p, i) => {
      parked.setMatrixAt(i, p.m);
      parked.setColorAt(i, _c.set(p.color));
    });
    parked.count = props.parked.length;
    parked.instanceMatrix.needsUpdate = true;
    if (parked.instanceColor) parked.instanceColor.needsUpdate = true;
    for (const m of [roof, panel, parked]) m.frustumCulled = false;
  }, [props]);

  return (
    <>
      <instancedMesh ref={roofRef} args={[undefined, undefined, MAX_STOPS]} castShadow>
        <boxGeometry args={[7, 0.9, 16]} />
        <meshStandardMaterial color="#2563eb" roughness={0.5} />
      </instancedMesh>
      <instancedMesh ref={panelRef} args={[undefined, undefined, MAX_STOPS]}>
        <boxGeometry args={[0.5, 8, 15]} />
        <meshStandardMaterial color="#bfe3ff" transparent opacity={0.55} roughness={0.2} />
      </instancedMesh>
      <instancedMesh ref={parkedRef} args={[undefined, undefined, MAX_PARKED]} castShadow>
        <boxGeometry args={[6.2, 4.5, 15]} />
        <meshStandardMaterial color="#ffffff" roughness={0.5} metalness={0.3} />
      </instancedMesh>
    </>
  );
}

export default memo(RoadsideProps);
