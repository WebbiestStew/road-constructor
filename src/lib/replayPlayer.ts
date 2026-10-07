"use client";

import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { useEditorStore } from "@/state/editorStore";
import { getScenarioById } from "@/sim/scenarios";
import { getRealCity, isRealCityLoaded, loadRealCity } from "@/sim/real";
import { pushToast } from "@/lib/toast";
import type { ReplayRecord } from "@/lib/replays";
import type { SceneryData } from "@/sim/osm/scenery";

type Sim = Pick<UseTrafficSimulationReturn, "playReplay" | "endReplay" | "setSpeedMultiplier" | "setRunning">;

/** The buildings and water around a replay's roads: a real level's own scenery, fetched if it isn't loaded yet, else none. */
async function sceneryFor(scenarioId: string | null): Promise<SceneryData | null> {
  const def = scenarioId ? getScenarioById(scenarioId) : undefined;
  if (!def?.real || !def.sceneryKey) return null;
  if (!isRealCityLoaded(def.sceneryKey)) await loadRealCity(def.sceneryKey);
  return getRealCity(def.sceneryKey).scenery ?? null;
}

/** Switches the screen to a recorded run and plays it from the start, in real time. Resolves false (with a message) if it couldn't. */
export async function beginReplay(sim: Sim, record: ReplayRecord): Promise<boolean> {
  try {
    const scenery = await sceneryFor(record.scenarioId);
    const store = useEditorStore.getState();
    if (!store.startReplay(record, record.actions, scenery)) {
      pushToast("That replay has no roads in it", "bad");
      return false;
    }
    sim.setSpeedMultiplier(1);
    sim.playReplay(record.actions);
    return true;
  } catch {
    pushToast("Couldn't open that replay: the map for its level didn't load", "bad");
    return false;
  }
}

/** Plays the open replay again from the top. */
export function restartReplay(sim: Sim): void {
  const store = useEditorStore.getState();
  const r = store.replay;
  if (!r) return;
  store.restartReplay();
  sim.playReplay(r.actions);
}

/** Leaves the replay, puts the player's city back, and hands the worker back to live play. */
export function leaveReplay(sim: Sim): void {
  useEditorStore.getState().exitReplay();
  sim.setSpeedMultiplier(1);
  sim.endReplay();
}
