"use client";

import { useEffect, useState } from "react";
import { fetchBoard, loadName, postScore, saveName, type Board } from "@/lib/leaderboard";

/**
 * Today's daily-challenge leaderboard, with a box to post your own score. Renders nothing at all when the site
 * has no leaderboard configured, so a deploy without Redis looks exactly as it did before.
 */
export default function DailyBoard({ day, score }: { day: string; score: number }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [name, setName] = useState(() => (typeof window === "undefined" ? "" : loadName()));
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "posting" } | { kind: "posted"; rank: number | null } | { kind: "error"; message: string }>({ kind: "idle" });

  useEffect(() => {
    let live = true;
    void fetchBoard(day).then((b) => live && setBoard(b));
    return () => {
      live = false;
    };
  }, [day]);

  if (!board || !board.enabled) return null;

  const post = async () => {
    setStatus({ kind: "posting" });
    const res = await postScore(day, name, score);
    if ("error" in res) {
      setStatus({ kind: "error", message: res.error });
      return;
    }
    saveName(name.trim());
    setStatus({ kind: "posted", rank: res.rank });
    setBoard(await fetchBoard(day));
  };

  const mine = name.trim().toLowerCase();
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl bg-black/[0.04] p-3 text-left">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-extrabold uppercase tracking-wide text-zinc-500">🏆 Today&apos;s board</span>
        <span className="text-[10.5px] font-semibold text-zinc-400">{board.total} {board.total === 1 ? "player" : "players"}</span>
      </div>
      {board.top.length === 0 ? (
        <p className="text-[11px] font-semibold text-zinc-500">Nobody has posted yet. Be the first.</p>
      ) : (
        <ol className="flex flex-col gap-0.5">
          {board.top.map((e, i) => (
            <li
              key={e.name}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-[11.5px] font-semibold ${e.name.toLowerCase() === mine ? "bg-amber-200/70 text-[#241b3d]" : "text-zinc-700"}`}
            >
              <span className="w-4 text-right tabular-nums text-zinc-400">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              <span className="font-display tabular-nums">{e.score}</span>
            </li>
          ))}
        </ol>
      )}
      {status.kind === "posted" ? (
        <p className="text-[11px] font-bold text-emerald-700">Posted{status.rank ? `: you're #${status.rank} today` : ""}.</p>
      ) : (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (status.kind !== "posting") void post();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={16}
            placeholder="Your name"
            className="min-w-0 flex-1 rounded-lg border-2 border-black/10 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#241b3d] outline-none focus:border-[#241b3d]/40"
          />
          <button
            type="submit"
            disabled={status.kind === "posting" || name.trim().length < 2 || score < 1}
            className="rounded-lg bg-[#241b3d] px-3 py-1.5 text-xs font-bold text-white transition active:scale-95 disabled:opacity-40"
          >
            Post {score}
          </button>
        </form>
      )}
      {status.kind === "error" && <p className="text-[11px] font-bold text-red-600">{status.message}</p>}
    </div>
  );
}
