"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import { closeSaves, setSavesTab, useSavesMenu } from "@/lib/savesMenu";
import { MAX_SLOTS, deleteSlot, listSlots, loadSlot, renameSlot, saveSlot, type SlotMeta } from "@/lib/saveSlots";
import { MAX_REPLAYS, deleteReplay, downloadReplayFile, listReplays, loadReplay, parseReplayFile, renameReplay, saveReplay, type ReplayMeta } from "@/lib/replays";
import { beginReplay } from "@/lib/replayPlayer";
import { useEditorStore } from "@/state/editorStore";
import { getScenarioById } from "@/sim/scenarios";
import { isRealCityLoaded, loadRealCity } from "@/sim/real";
import { pushToast } from "@/lib/toast";

function when(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function mmss(s: number): string {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, "0")}`;
}

const btn = "rounded-full px-2.5 py-1 text-[11px] font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40";
const btnPlain = `${btn} bg-black/5 text-zinc-700 hover:bg-black/10`;
const btnMain = `${btn} bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm hover:brightness-110`;

function message(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong with the save";
}

/** Save slots (a city under a name, with the level it belonged to) and the replays of runs. Opens from the top bar's Saves button. */
export default function SavesMenu({ sim }: { sim: UseTrafficSimulationReturn }) {
  const { open, tab } = useSavesMenu();
  const replaying = useEditorStore((s) => s.replay !== null);
  const [slots, setSlots] = useState<SlotMeta[] | null>(null);
  const [replays, setReplays] = useState<ReplayMeta[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([listSlots(), listReplays()]);
      setSlots(s);
      setReplays(r);
    } catch (e) {
      setSlots([]);
      setReplays([]);
      pushToast(message(e), "bad");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => void refresh());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeSaves();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, refresh]);

  if (!open) return null;

  const store = useEditorStore.getState;
  const currentContext = () => {
    const s = store();
    const def = s.activeScenarioId ? getScenarioById(s.activeScenarioId) : undefined;
    return { scenarioId: s.activeScenarioId, scenarioName: def?.name ?? null, placeName: s.placeName };
  };

  const save = async (replaceId?: string) => {
    const s = store();
    if (s.nodes.length === 0) {
      pushToast("There's nothing on the map to save yet", "alert");
      return;
    }
    setBusy(true);
    try {
      const ctx = currentContext();
      const label = name.trim() || ctx.scenarioName || ctx.placeName || "My city";
      await saveSlot(label, s.exportPayload(), ctx, replaceId);
      setName("");
      pushToast(`💾 Saved “${label}”`, "good");
      await refresh();
    } catch (e) {
      pushToast(message(e), "bad");
    }
    setBusy(false);
  };

  const load = async (meta: SlotMeta) => {
    const s = store();
    if (s.edges.length > 0 && !window.confirm("Replace the city on screen with this save? Your current one is autosaved, and Undo brings it back.")) return;
    setBusy(true);
    try {
      const slot = await loadSlot(meta.id);
      if (!slot) throw new Error("That save is gone");
      const def = slot.meta.scenarioId ? getScenarioById(slot.meta.scenarioId) : undefined;
      if (def?.real && def.sceneryKey && !isRealCityLoaded(def.sceneryKey)) {
        pushToast(`Loading ${def.name}…`, "info");
        await loadRealCity(def.sceneryKey);
      }
      const st = store();
      if (def) st.loadScenario(def);
      else if (st.activeScenarioId) st.exitScenario();
      st.importPayload(slot.payload);
      const ns = slot.payload.network.nodes;
      if (ns.length > 0) {
        const xs = ns.map((n) => n.position[0]);
        const zs = ns.map((n) => n.position[2]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        st.requestCameraFit({ centerX: cx, centerZ: cz, radiusFt: 1.2 * Math.max((Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...zs) - Math.min(...zs)) / 2) });
      }
      pushToast(`📂 Opened “${slot.meta.name}”`, "good");
      closeSaves();
    } catch (e) {
      pushToast(message(e), "bad");
    }
    setBusy(false);
  };

  const watch = async (meta: ReplayMeta) => {
    setBusy(true);
    try {
      const record = await loadReplay(meta.id);
      if (!record) throw new Error("That replay is gone");
      closeSaves();
      await beginReplay(sim, record);
    } catch (e) {
      pushToast(message(e), "bad");
    }
    setBusy(false);
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const record = await parseReplayFile(file);
      if (!record) {
        pushToast("That file isn't a Road Constructor replay (or it is damaged)", "bad");
      } else {
        const { actions, ...meta } = record;
        await saveReplay({ ...meta, actions });
        pushToast(`🎞️ Added “${record.name}”`, "good");
        await refresh();
      }
    } catch (e) {
      pushToast(message(e), "bad");
    }
    setBusy(false);
  };

  const ask = (label: string, current: string): string | null => {
    const v = window.prompt(label, current);
    return v === null ? null : v.trim() || current;
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[64] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && closeSaves()}
      role="dialog"
      aria-modal="true"
      aria-label="Saves and replays"
    >
      <div className="hud-panel flex max-h-[88vh] w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-3xl p-5 hud-scrollbar">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-extrabold uppercase text-[#241b3d]">💾 Saves &amp; replays</h2>
          <button type="button" onClick={closeSaves} className={btnPlain}>
            Done
          </button>
        </div>

        <div className="flex gap-1 rounded-xl bg-black/5 p-1">
          {(["saves", "replays"] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setSavesTab(t)}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-bold ${tab === t ? "bg-white text-[#241b3d] shadow" : "text-zinc-500 hover:text-zinc-800"}`}
            >
              {t === "saves" ? `Cities (${slots?.length ?? 0}/${MAX_SLOTS})` : `Replays (${replays?.length ?? 0}/${MAX_REPLAYS})`}
            </button>
          ))}
        </div>

        {replaying && <p className="rounded-xl bg-violet-50 px-3 py-2 text-[12px] font-semibold text-violet-800">A replay is open. Exit it to save or open a city.</p>}

        {tab === "saves" ? (
          <>
            <div className="flex flex-col gap-2 rounded-2xl bg-black/[0.03] p-3">
              <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-zinc-400">Save the city on screen</span>
              <div className="flex gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 40))}
                  placeholder={currentContext().scenarioName ?? "Name this city"}
                  className="min-w-0 flex-1 rounded-xl border border-black/10 bg-white px-3 py-1.5 text-sm font-semibold text-[#241b3d] outline-none focus:border-violet-400"
                  onKeyDown={(e) => e.key === "Enter" && !busy && !replaying && void save()}
                />
                <button type="button" disabled={busy || replaying || (slots?.length ?? 0) >= MAX_SLOTS} onClick={() => void save()} className={btnMain}>
                  Save
                </button>
              </div>
              <span className="text-[11px] font-semibold text-zinc-500">Roads, budget and bus lines, with the level it belongs to. Kept in this browser.</span>
            </div>
            {slots === null ? (
              <p className="text-sm font-semibold text-zinc-500">Loading…</p>
            ) : slots.length === 0 ? (
              <p className="px-1 text-sm font-semibold text-zinc-500">Nothing saved yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {slots.map((s) => (
                  <li key={s.id} className="flex flex-col gap-1.5 rounded-2xl border border-black/10 bg-white p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-display text-sm font-extrabold text-[#241b3d]">{s.name}</span>
                      <span className="shrink-0 text-[10.5px] font-semibold text-zinc-400">{when(s.savedAt)}</span>
                    </div>
                    <span className="text-[11px] font-semibold text-zinc-500">
                      {s.scenarioName ?? s.placeName ?? "Free build"} · {s.roads} roads · {s.budget > 5e8 ? "no money limit" : `$${Math.round(s.budget).toLocaleString()}`}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      <button type="button" disabled={busy || replaying} onClick={() => void load(s)} className={btnMain}>
                        Open
                      </button>
                      <button type="button" disabled={busy || replaying} onClick={() => void save(s.id)} className={btnPlain} title="Replace this save with the city on screen">
                        Overwrite
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const v = ask("Name this save", s.name);
                          if (v) {
                            await renameSlot(s.id, v);
                            await refresh();
                          }
                        }}
                        className={btnPlain}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!window.confirm(`Delete “${s.name}”?`)) return;
                          await deleteSlot(s.id);
                          await refresh();
                        }}
                        className={`${btn} text-red-600 hover:bg-red-50`}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 rounded-2xl bg-black/[0.03] p-3">
              <span className="text-[11px] font-semibold leading-snug text-zinc-500">
                A replay is the run itself, played back exactly: the same traffic, the same trouble, the same fixes you made at the same moments. Finish a level and save its replay from the results.
              </span>
              <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className={btnPlain}>
                Open a file…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".rcreplay,application/gzip,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = "";
                }}
              />
            </div>
            {replays === null ? (
              <p className="text-sm font-semibold text-zinc-500">Loading…</p>
            ) : replays.length === 0 ? (
              <p className="px-1 text-sm font-semibold text-zinc-500">No replays yet. Finish a level, then press “Save the replay” on the results card.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {replays.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1.5 rounded-2xl border border-black/10 bg-white p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-display text-sm font-extrabold text-[#241b3d]">{r.name}</span>
                      <span className="shrink-0 text-[10.5px] font-semibold text-zinc-400">{when(r.savedAt)}</span>
                    </div>
                    <span className="text-[11px] font-semibold text-zinc-500">
                      {r.scenarioName} · {mmss(r.durationS)}
                      {r.stars > 0 ? ` · ${"★".repeat(r.stars)}` : ""}
                      {r.summary ? ` · ${r.summary}` : ""}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      <button type="button" disabled={busy || replaying} onClick={() => void watch(r)} className={btnMain}>
                        ▶ Watch
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const rec = await loadReplay(r.id);
                          if (rec) await downloadReplayFile(rec);
                        }}
                        className={btnPlain}
                      >
                        ⬇ File
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const v = ask("Name this replay", r.name);
                          if (v) {
                            await renameReplay(r.id, v);
                            await refresh();
                          }
                        }}
                        className={btnPlain}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!window.confirm(`Delete “${r.name}”?`)) return;
                          await deleteReplay(r.id);
                          await refresh();
                        }}
                        className={`${btn} text-red-600 hover:bg-red-50`}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
