import type { NextRequest } from "next/server";

/**
 * The daily-challenge leaderboard: one best score per name per day, kept in Redis (Upstash, free tier) behind
 * its REST API so no database driver is needed. With no Redis configured the endpoint reports `enabled: false`
 * and the game simply hides the board, so the site works the same without it.
 *
 * Scores are reported by the browser, so this is an honour-system board: it checks that a score is plausible and
 * rate-limits posting, but it can't prove a run was played.
 */

const URL_ENV = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const TOKEN_ENV = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[A-Za-z0-9 _.\-]{2,16}$/;
/// Obvious slurs and the like; a small net, not moderation.
const BLOCKED = /(fuck|shit|cunt|nigg|fagg|bitch|rape|nazi|hitler)/i;
const MAX_SCORE = 3000;
const TTL_S = 60 * 60 * 24 * 4;
const POSTS_PER_MINUTE = 10;

type Cmd = (string | number)[];

async function redis(commands: Cmd[]): Promise<unknown[]> {
  const res = await fetch(`${URL_ENV}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_ENV}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const rows = (await res.json()) as { result?: unknown; error?: string }[];
  return rows.map((r) => r.result);
}

/** The player's calendar day can be a day either side of the server's (time zones), but not further. */
function dayIsCurrent(day: string): boolean {
  const t = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return Math.abs(t - Date.now()) < 1000 * 60 * 60 * 36;
}

function topFrom(raw: unknown): { name: string; score: number }[] {
  const flat = Array.isArray(raw) ? (raw as (string | number)[]) : [];
  const out: { name: string; score: number }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ name: String(flat[i]), score: Number(flat[i + 1]) });
  return out;
}

export async function GET(request: NextRequest) {
  if (!URL_ENV || !TOKEN_ENV) return Response.json({ enabled: false });
  const day = request.nextUrl.searchParams.get("day") ?? "";
  if (!DAY_RE.test(day) || !dayIsCurrent(day)) return Response.json({ enabled: true, top: [], total: 0 });
  try {
    const [top, total] = await redis([["ZREVRANGE", `lb:${day}`, 0, 9, "WITHSCORES"], ["ZCARD", `lb:${day}`]]);
    return Response.json({ enabled: true, top: topFrom(top), total: Number(total) || 0 });
  } catch {
    return Response.json({ enabled: false });
  }
}

export async function POST(request: NextRequest) {
  if (!URL_ENV || !TOKEN_ENV) return Response.json({ enabled: false }, { status: 503 });
  let body: { day?: unknown; name?: unknown; score?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const day = String(body.day ?? "");
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  const score = Number(body.score);
  if (!DAY_RE.test(day) || !dayIsCurrent(day)) return Response.json({ error: "That day's board is closed" }, { status: 400 });
  if (!NAME_RE.test(name) || BLOCKED.test(name.replace(/[ _.\-]/g, ""))) return Response.json({ error: "Pick a name of 2-16 letters or numbers" }, { status: 400 });
  if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) return Response.json({ error: "That score doesn't look right" }, { status: 400 });

  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  try {
    const [count] = await redis([["INCR", `rl:${ip}`], ["EXPIRE", `rl:${ip}`, 60]]);
    if (Number(count) > POSTS_PER_MINUTE) return Response.json({ error: "Slow down a little" }, { status: 429 });
    const key = `lb:${day}`;
    // GT keeps the best score only; the key expires a few days after its last write.
    const [, , rank, total] = await redis([["ZADD", key, "GT", score, name], ["EXPIRE", key, TTL_S], ["ZREVRANK", key, name], ["ZCARD", key]]);
    return Response.json({ enabled: true, rank: rank === null || rank === undefined ? null : Number(rank) + 1, total: Number(total) || 0 });
  } catch {
    return Response.json({ error: "The leaderboard is unavailable" }, { status: 502 });
  }
}
