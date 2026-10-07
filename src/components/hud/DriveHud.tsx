"use client";

import { useEffect, useRef, useState } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import type { DriveResult, DriveView } from "@/sim/types";
import { useEditorStore } from "@/state/editorStore";
import { RADIO_STATIONS, getRadioStation, playBrakeSqueal, playIndicatorTick, setPlayerEngine, setRadioStation, setSirenSound, type RadioStation } from "@/lib/sound";
import type { VehicleKind } from "@/sim/types";
import { pushToast } from "@/lib/toast";
import { useCoarsePointer, useCompact } from "@/lib/compact";

const KIND_LABEL: Record<VehicleKind, { emoji: string; label: string }> = {
  car: { emoji: "🚗", label: "Car" },
  truck: { emoji: "🚛", label: "Truck" },
  bus: { emoji: "🚌", label: "Bus" },
  bike: { emoji: "🚲", label: "Bike" },
  ambulance: { emoji: "🚑", label: "Ambulance" },
  police: { emoji: "🚓", label: "Police" },
  wrecker: { emoji: "🛻", label: "Wrecker" },
  debris: { emoji: "🧱", label: "Debris" },
};
const PICKER_KINDS: (VehicleKind | "any")[] = ["any", "car", "truck", "bus", "bike", "ambulance"];

const MOVE_ICON: Record<DriveView["nextMove"], string> = { left: "↰", straight: "↑", right: "↱", end: "🏁" };

function mmss(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, "0")}`;
}

/** What a result says about the drive, in a sentence. */
function verdict(r: DriveResult): string {
  if (!r.arrived) return "The trip ended before you got there.";
  const over = r.elapsedS - r.idealS;
  if (r.score >= 90 && over < 25) return "A clean, quick drive.";
  if (r.score >= 90) return "Smooth and safe. Traffic was the only thing slowing you.";
  if (r.speedingS > r.hardBrakes * 4) return "You got there by speeding. A fast road is not a good one.";
  if (r.hardBrakes >= 3) return "A lot of hard stops: leave more room to the car ahead.";
  return "Made it.";
}

/**
 * Take the wheel: while riding along, a button drops you into the driver's seat of the car the camera follows. W/S are
 * the throttle and the brake, A/D ask for a lane change (the car moves over when there is a gap), C swaps between
 * chasing the car and sitting in it, Esc lets go. The car still keeps its distance and stops at red lights; the route
 * is the one its driver set out on, so the lane arrows matter. This component also owns the keyboard, the speedometer
 * and the result card. Renders nothing when not riding along.
 */
export default function DriveHud({ sim }: { sim: UseTrafficSimulationReturn }) {
  const rideAlong = useEditorStore((s) => s.rideAlongActive);
  const drivingId = useEditorStore((s) => s.drivingId);
  const riding = useEditorStore((s) => s.rideAlongVehicleId);
  const cam = useEditorStore((s) => s.driveCam);
  const setDrivingId = useEditorStore((s) => s.setDrivingId);
  const setDriveCam = useEditorStore((s) => s.setDriveCam);
  const [view, setView] = useState<DriveView | null>(null);
  const [radio, setRadio] = useState<RadioStation>(() => getRadioStation());
  const kind = useEditorStore((s) => s.rideAlongVehicleKind);
  const filter = useEditorStore((s) => s.rideAlongFilter);
  const setFilter = useEditorStore((s) => s.setRideAlongFilter);
  const stepRideAlong = useEditorStore((s) => s.stepRideAlong);
  const [result, setResult] = useState<DriveResult | null>(null);
  const viewRef = useRef<DriveView | null>(null);
  const lastBrakes = useRef(0);
  const { snapshotRef, takeWheel, releaseWheel, driveInput, driveResult, clearDriveResult } = sim;
  const coarse = useCoarsePointer();
  const compact = useCompact();
  const touch = coarse || compact;

  // The sim reports a finished drive: show the card and hand the camera back.
  useEffect(() => {
    if (!driveResult) return;
    const raf = requestAnimationFrame(() => {
      setResult(driveResult);
      setDrivingId(null);
      setView(null);
      setPlayerEngine(false);
    });
    return () => cancelAnimationFrame(raf);
  }, [driveResult, setDrivingId]);

  // Read the live numbers a few times a second (and run the engine from them every frame), without re-rendering at 30 Hz.
  useEffect(() => {
    if (drivingId === null) return;
    let raf = 0;
    let last = 0;
    let missing = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const v = snapshotRef.current?.drive ?? null;
      viewRef.current = v;
      if (v) {
        missing = 0;
        setPlayerEngine(true, v.speedMph, v.thrusting, v.kind);
        if (v.hardBrakes > lastBrakes.current) playBrakeSqueal();
        lastBrakes.current = v.hardBrakes;
      } else if (++missing > 90) {
        // the car is gone without a result (the run was reset): let go
        setDrivingId(null);
      }
      if (now - last > 90) {
        last = now;
        setView(v);
      }
    };
    lastBrakes.current = 0;
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      setPlayerEngine(false);
    };
  }, [drivingId, snapshotRef, setDrivingId]);

  // The radio plays only while you are behind the wheel; an ambulance runs its siren.
  const driving = drivingId !== null;
  useEffect(() => {
    if (!driving) {
      setRadioStation("off");
      return;
    }
    setRadioStation(radio);
  }, [driving, radio]);
  const drivenKind = view?.kind ?? null;
  const emergencyActive = sim.metrics.emergency.active > 0;
  useEffect(() => {
    if (!driving || drivenKind !== "ambulance") return;
    setSirenSound(true);
    return () => setSirenSound(emergencyActive && sim.running);
  }, [driving, drivenKind, emergencyActive, sim.running]);

  // The indicator ticks while a lane change is waiting for a gap.
  const pending = view?.laneChangePending ?? false;
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(playIndicatorTick, 340);
    return () => window.clearInterval(t);
  }, [pending]);

  // Keys.
  useEffect(() => {
    if (drivingId === null) return;
    const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "w" || k === "arrowup") driveInput({ accel: 1 });
      else if (k === "s" || k === "arrowdown") driveInput({ accel: -1 });
      else if ((k === "a" || k === "arrowleft") && !e.repeat) driveInput({ lane: -1 });
      else if ((k === "d" || k === "arrowright") && !e.repeat) driveInput({ lane: 1 });
      else if (k === "c" && !e.repeat) setDriveCam(useEditorStore.getState().driveCam === "chase" ? "hood" : "chase");
      else if (k === "escape") {
        e.stopPropagation();
        releaseWheel();
        setDrivingId(null);
        return;
      } else return;
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w" || k === "arrowup" || k === "s" || k === "arrowdown") driveInput({ accel: 0 });
    };
    const blur = () => driveInput({ accel: 0 });
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [drivingId, driveInput, releaseWheel, setDrivingId, setDriveCam]);

  const take = () => {
    if (riding === null) return;
    clearDriveResult();
    setResult(null);
    setDrivingId(riding);
    takeWheel(riding);
    pushToast(touch ? "🚗 You have the wheel: hold GAS and BRAKE, tap the LANE arrows to move over" : "🚗 You have the wheel: W/S throttle and brake, A/D change lane, C changes view, Esc lets go", "info");
  };

  if (!rideAlong) return null;

  if (drivingId === null) {
    return (
      <>
        <div className="pointer-events-auto absolute bottom-20 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
          <div className="hud-panel flex flex-wrap items-center justify-center gap-1.5 rounded-2xl px-2.5 py-1.5">
            <button type="button" aria-label="Previous vehicle" onClick={() => stepRideAlong(-1)} className="rounded-full bg-black/5 px-2.5 py-1 text-xs font-bold text-zinc-700 hover:bg-black/10 active:scale-95">
              ◀
            </button>
            <span className="min-w-24 text-center text-xs font-extrabold text-[#241b3d]">
              {kind ? `${KIND_LABEL[kind].emoji} ${KIND_LABEL[kind].label}${riding !== null ? ` #${riding}` : ""}` : "Finding a vehicle…"}
            </span>
            <button type="button" aria-label="Next vehicle" onClick={() => stepRideAlong(1)} className="rounded-full bg-black/5 px-2.5 py-1 text-xs font-bold text-zinc-700 hover:bg-black/10 active:scale-95">
              ▶
            </button>
            <div className="flex gap-0.5">
              {PICKER_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={filter === k}
                  title={k === "any" ? "Any vehicle" : KIND_LABEL[k].label}
                  onClick={() => {
                    setFilter(k);
                    stepRideAlong(1);
                  }}
                  className={`rounded-full px-2 py-1 text-xs transition active:scale-95 ${filter === k ? "bg-[#241b3d] text-white" : "bg-black/5 text-zinc-600 hover:bg-black/10"}`}
                >
                  {k === "any" ? "All" : KIND_LABEL[k].emoji}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={take}
            disabled={riding === null || !sim.running}
            title={sim.running ? "Drive this car yourself" : "Open the city to traffic first"}
            className="flex items-center gap-2 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 px-5 py-2.5 text-sm font-extrabold text-white shadow-lg transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {kind ? KIND_LABEL[kind].emoji : "🚗"} Take the wheel
          </button>
        </div>
        {result && <ResultCard result={result} onAgain={take} onClose={() => setResult(null)} />}
      </>
    );
  }

  const v = view;
  const over = v ? v.speedMph > v.limitMph * 1.1 : false;
  return (
    <div className={`pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center gap-2 px-2 ${touch ? "bottom-[7.5rem]" : "bottom-4"}`}>
      {v && (
        <div className="hud-panel pointer-events-auto flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-3xl px-5 py-3">
          <div className="flex flex-col items-center leading-none" title="Where the route goes at the end of this road">
            <span className={`font-display text-3xl font-black ${!v.laneOk ? "text-red-600" : "text-[#241b3d]"}`}>{MOVE_ICON[v.nextMove]}</span>
            <span className="text-[10.5px] font-bold text-zinc-500">{v.nextMove === "end" ? "last road" : `${Math.round(v.toJunctionFt / 10) * 10} ft`}</span>
            {v.streetName && <span className="mt-0.5 max-w-[8rem] truncate text-[10px] font-semibold text-zinc-400">{v.streetName}</span>}
            <span className="mt-0.5 text-[10px] font-bold text-zinc-400">{KIND_LABEL[v.kind].emoji} {KIND_LABEL[v.kind].label}</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex flex-col items-center leading-none">
              <span className={`font-display text-5xl font-black tabular-nums ${over ? "text-red-600" : "text-[#241b3d]"}`}>{Math.round(v.speedMph)}</span>
              <span className="text-[10px] font-extrabold uppercase tracking-wide text-zinc-400">mph</span>
            </div>
            <div className={`font-display flex h-11 w-11 items-center justify-center rounded-full border-[3.5px] bg-white text-base font-extrabold tabular-nums ${over ? "border-red-600 text-red-600" : "border-red-500/70 text-[#241b3d]"}`} title="Speed limit">
              {Math.round(v.limitMph)}
            </div>
          </div>

          <div className="flex flex-col items-center gap-1" title="Your lane">
            <div className="flex gap-1">
              {Array.from({ length: v.lanes }, (_, i) => (
                <span
                  key={i}
                  className={`h-5 w-3 rounded-sm ${i === v.laneIndex ? (v.laneOk ? "bg-violet-600" : "bg-red-500") : v.laneAllowed?.[i] ? "bg-emerald-400/70" : "bg-black/15"}`}
                />
              ))}
            </div>
            <span className={`text-[10.5px] font-bold ${v.laneBlocked ? "text-red-600" : v.laneChangePending ? "text-amber-600" : v.laneOk ? "text-zinc-500" : "text-red-600"}`}>
              {v.laneBlocked ? "no gap" : v.laneChangePending ? "waiting for a gap…" : v.laneOk ? "lane" : "wrong lane: green is right"}
            </span>
          </div>

          <div className="flex flex-col items-center leading-none">
            <span className="font-display text-xl font-extrabold tabular-nums text-[#241b3d]">{mmss(v.elapsedS)}</span>
            <span className="text-[10px] font-bold text-zinc-400">at the limit: {mmss(v.idealS)}</span>
          </div>

          {v.stopAheadFt !== null && v.stopAheadFt < 160 && (
            <span className="rounded-full bg-red-500/15 px-3 py-1 text-xs font-extrabold text-red-700">🛑 stop in {Math.max(5, Math.round(v.stopAheadFt / 5) * 5)} ft</span>
          )}
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-black/55 px-4 py-1.5 text-[11px] font-bold text-white">
        {!touch && (
          <span>
            <kbd className="rounded bg-white/20 px-1">W</kbd> gas · <kbd className="rounded bg-white/20 px-1">S</kbd> brake · <kbd className="rounded bg-white/20 px-1">A</kbd>
            <kbd className="ml-0.5 rounded bg-white/20 px-1">D</kbd> lane
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            const i = RADIO_STATIONS.findIndex((r) => r.id === radio);
            setRadio(RADIO_STATIONS[(i + 1) % RADIO_STATIONS.length].id);
          }}
          className="rounded-full bg-white/15 px-2.5 py-0.5 hover:bg-white/25"
          title="Change the radio station"
        >
          {RADIO_STATIONS.find((r) => r.id === radio)?.emoji} {RADIO_STATIONS.find((r) => r.id === radio)?.label}
        </button>
        <button type="button" onClick={() => setDriveCam(cam === "chase" ? "hood" : "chase")} className="rounded-full bg-white/15 px-2.5 py-0.5 hover:bg-white/25">
          📷 {cam === "chase" ? "Driver's seat" : "Chase view"}{touch ? "" : " (C)"}
        </button>
        <button
          type="button"
          onClick={() => {
            releaseWheel();
            setDrivingId(null);
          }}
          className="rounded-full bg-white/15 px-2.5 py-0.5 hover:bg-white/25"
        >
          Let go{touch ? "" : " (Esc)"}
        </button>
      </div>
      {touch && <TouchPedals driveInput={driveInput} thrusting={v?.thrusting ?? 0} />}
    </div>
  );
}

/** On-screen controls for a touch screen: lane changes on the left, brake and gas (hold them) on the right. */
function TouchPedals({ driveInput, thrusting }: { driveInput: (i: { accel?: -1 | 0 | 1; lane?: -1 | 0 | 1 }) => void; thrusting: number }) {
  const hold = (accel: -1 | 1) => ({
    onPointerDown: (e: React.PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      driveInput({ accel });
    },
    onPointerUp: () => driveInput({ accel: 0 }),
    onPointerCancel: () => driveInput({ accel: 0 }),
  });
  const pedal = "pointer-events-auto flex h-20 w-20 touch-none select-none flex-col items-center justify-center rounded-3xl text-xs font-extrabold uppercase text-white shadow-lg active:scale-95";
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-4 flex items-end justify-between">
      <div className="flex gap-2">
        <button type="button" aria-label="Change lane left" onClick={() => driveInput({ lane: -1 })} className={`${pedal} bg-gradient-to-br from-sky-400 to-blue-600`}>
          <span className="text-3xl leading-none">◀</span>lane
        </button>
        <button type="button" aria-label="Change lane right" onClick={() => driveInput({ lane: 1 })} className={`${pedal} bg-gradient-to-br from-sky-400 to-blue-600`}>
          <span className="text-3xl leading-none">▶</span>lane
        </button>
      </div>
      <div className="flex gap-2">
        <button type="button" aria-label="Brake (hold)" {...hold(-1)} className={`${pedal} ${thrusting < 0 ? "from-red-500 to-red-700" : "from-rose-400 to-red-600"} bg-gradient-to-br`}>
          <span className="text-2xl leading-none">🛑</span>brake
        </button>
        <button type="button" aria-label="Gas (hold)" {...hold(1)} className={`${pedal} ${thrusting > 0 ? "from-emerald-500 to-green-700" : "from-emerald-400 to-teal-600"} bg-gradient-to-br`}>
          <span className="text-2xl leading-none">⛽</span>gas
        </button>
      </div>
    </div>
  );
}

function ResultCard({ result, onAgain, onClose }: { result: DriveResult; onAgain: () => void; onClose: () => void }) {
  return (
    <div className="pointer-events-auto absolute left-1/2 top-24 z-30 flex w-80 -translate-x-1/2 flex-col gap-2 rounded-2xl hud-panel p-4 text-center">
      <span className="font-display text-xs font-extrabold uppercase tracking-wide text-zinc-500">{result.arrived ? "You arrived" : "Drive over"}</span>
      <span className="font-display text-4xl font-black text-[#241b3d]">{result.score}<span className="text-base text-zinc-400"> / 100</span></span>
      <span className="text-[12px] font-semibold text-zinc-600">{verdict(result)}</span>
      <div className="grid grid-cols-2 gap-1.5 text-left text-[11px] font-semibold text-zinc-600">
        <span className="rounded-lg bg-black/[0.04] px-2 py-1">Time <b className="float-right tabular-nums text-[#241b3d]">{mmss(result.elapsedS)}</b></span>
        <span className="rounded-lg bg-black/[0.04] px-2 py-1">At the limit <b className="float-right tabular-nums text-[#241b3d]">{mmss(result.idealS)}</b></span>
        <span className="rounded-lg bg-black/[0.04] px-2 py-1">Hard stops <b className="float-right tabular-nums text-[#241b3d]">{result.hardBrakes}</b></span>
        <span className="rounded-lg bg-black/[0.04] px-2 py-1">Speeding <b className="float-right tabular-nums text-[#241b3d]">{Math.round(result.speedingS)} s</b></span>
        <span className="rounded-lg bg-black/[0.04] px-2 py-1">Distance <b className="float-right tabular-nums text-[#241b3d]">{(result.distanceFt / 5280).toFixed(2)} mi</b></span>
        <span className="rounded-lg bg-black/[0.04] px-2 py-1">Lane changes <b className="float-right tabular-nums text-[#241b3d]">{result.laneChanges}</b></span>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onAgain} className="flex-1 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 py-2 text-xs font-bold text-white shadow-sm hover:brightness-110 active:scale-95">
          Drive another
        </button>
        <button type="button" onClick={onClose} className="flex-1 rounded-xl bg-black/5 py-2 text-xs font-bold text-zinc-700 hover:bg-black/10 active:scale-95">
          Close
        </button>
      </div>
    </div>
  );
}
