import type { NextRequest } from "next/server";
import { z } from "zod";
import { isValidNetwork } from "@/state/persistence";
import { BLOCKED, clientIp, rateLimited, redis, redisConfigured } from "@/lib/server/redis";

/**
 * The community gallery: levels players have published (their city plus the unchanged-city score it was measured at),
 * kept in Redis. Anyone can read; posting is rate-limited and size-limited, names are screened, a device can like or
 * report a level once, and a level reported by three different devices is hidden.
 *
 * What it can't do: prove that the measured baseline is honest. The star lines come from the author's own browser, so
 * the gallery shows them as "measured by the author".
 */

const MAX_BODY_CHARS = 700_000;
const MAX_ROADS = 2500;
const HIDE_AFTER_REPORTS = 3;
const NAME_RE = /^[\p{L}\p{N} _.'&!\-]{3,32}$/u;
const FROM_RE = /^[A-Za-z0-9 _.\-]{2,16}$/;
const DEVICE_RE = /^[A-Za-z0-9]{12,40}$/;
const PAGE = 20;
/** Sort score for "top": likes first, then recency. */
const TOP_UNIT = 1e13;

const publishSchema = z.object({
  action: z.literal("publish"),
  name: z.string(),
  from: z.string(),
  baseline: z.number().int().min(20).max(6000),
  delayShare: z.number().min(0).max(20).optional(),
  queueFt: z.number().min(0).max(100000).optional(),
  bus: z.number().min(0).max(0.5).optional(),
  bike: z.number().min(0).max(0.5).optional(),
  network: z.unknown(),
});

interface Meta {
  id: string;
  name: string;
  from: string;
  baseline: number;
  at: number;
  likes: number;
  plays: number;
  reports: number;
  roads: number;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((b) => (b % 36).toString(36)).join("");
}

function parseMeta(raw: unknown): Meta | null {
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as Meta) : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  if (!redisConfigured()) return Response.json({ enabled: false });
  const params = request.nextUrl.searchParams;
  try {
    const id = params.get("id");
    if (id) {
      if (!/^[a-z0-9]{8}$/.test(id)) return Response.json({ enabled: true, error: "not found" }, { status: 404 });
      const [raw, hidden] = await redis([["GET", `lv:${id}`], ["SISMEMBER", "lv:hidden", id]]);
      if (!raw || Number(hidden) === 1) return Response.json({ enabled: true, error: "not found" }, { status: 404 });
      return Response.json({ enabled: true, level: JSON.parse(String(raw)) });
    }
    const sort = params.get("sort") === "top" ? "lv:top" : "lv:new";
    const offset = Math.max(0, Math.min(1000, Number(params.get("offset") ?? 0) || 0));
    const [ids] = await redis([["ZREVRANGE", sort, offset, offset + PAGE - 1]]);
    const list = Array.isArray(ids) ? (ids as string[]) : [];
    if (list.length === 0) return Response.json({ enabled: true, levels: [], more: false });
    const metas = (await redis([["MGET", ...list.map((i) => `lvm:${i}`)]]))[0];
    const levels = (Array.isArray(metas) ? metas : []).map(parseMeta).filter((m): m is Meta => !!m);
    return Response.json({ enabled: true, levels, more: list.length === PAGE });
  } catch {
    return Response.json({ enabled: false });
  }
}

export async function POST(request: NextRequest) {
  if (!redisConfigured()) return Response.json({ enabled: false }, { status: 503 });
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return Response.json({ error: "That level is too big to post" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const device = String(request.headers.get("x-rc-device") ?? "");
  if (!DEVICE_RE.test(device)) return Response.json({ error: "bad request" }, { status: 400 });
  const ip = clientIp(request);

  try {
    if (await rateLimited("lv", ip, 60, 60)) return Response.json({ error: "Slow down a little" }, { status: 429 });
    const action = body.action;

    if (action === "publish") {
      const parsed = publishSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: "That level doesn't look right" }, { status: 400 });
      const d = parsed.data;
      const name = d.name.trim().replace(/\s+/g, " ");
      const from = d.from.trim().replace(/\s+/g, " ");
      if (!NAME_RE.test(name) || BLOCKED.test(name.replace(/[ _.'\-]/g, ""))) return Response.json({ error: "Pick a name of 3-32 letters or numbers" }, { status: 400 });
      if (!FROM_RE.test(from) || BLOCKED.test(from.replace(/[ _.\-]/g, ""))) return Response.json({ error: "Pick a name of 2-16 letters or numbers" }, { status: 400 });
      if (!isValidNetwork(d.network)) return Response.json({ error: "That city failed the check" }, { status: 400 });
      const net = d.network;
      if (net.edges.length > MAX_ROADS || net.nodes.length > MAX_ROADS) return Response.json({ error: "That city has too many roads" }, { status: 400 });
      const hasEntry = net.edges.some((e) => e.zone?.type === "entry");
      const hasDest = net.edges.some((e) => e.zone?.type === "destination");
      if (!hasEntry || !hasDest) return Response.json({ error: "A level needs an entry and a destination" }, { status: 400 });
      if ((await rateLimited("lvpub-ip", ip, 6, 3600)) || (await rateLimited("lvpub-dev", device, 10, 86400))) {
        return Response.json({ error: "You've posted a lot of levels. Try again later" }, { status: 429 });
      }
      const id = newId();
      const at = Date.now();
      const payload = { id, name, from, baseline: d.baseline, delayShare: d.delayShare, queueFt: d.queueFt, bus: d.bus, bike: d.bike, network: net, at };
      const meta: Meta = { id, name, from, baseline: d.baseline, at, likes: 0, plays: 0, reports: 0, roads: net.edges.length };
      await redis([
        ["SET", `lv:${id}`, JSON.stringify(payload)],
        ["SET", `lvm:${id}`, JSON.stringify(meta)],
        ["ZADD", "lv:new", at, id],
        ["ZADD", "lv:top", at, id],
      ]);
      return Response.json({ enabled: true, id });
    }

    const id = String(body.id ?? "");
    if (!/^[a-z0-9]{8}$/.test(id)) return Response.json({ error: "bad request" }, { status: 400 });
    const [rawMeta] = await redis([["GET", `lvm:${id}`]]);
    const meta = parseMeta(rawMeta);
    if (!meta) return Response.json({ error: "not found" }, { status: 404 });

    if (action === "like") {
      const [added] = await redis([["SADD", `lvlikes:${id}`, device]]);
      if (Number(added) === 1) {
        meta.likes++;
        await redis([["SET", `lvm:${id}`, JSON.stringify(meta)], ["ZADD", "lv:top", meta.likes * TOP_UNIT + meta.at, id]]);
      }
      return Response.json({ enabled: true, likes: meta.likes });
    }
    if (action === "play") {
      meta.plays++;
      await redis([["SET", `lvm:${id}`, JSON.stringify(meta)]]);
      return Response.json({ enabled: true });
    }
    if (action === "report") {
      const [added] = await redis([["SADD", `lvrep:${id}`, device]]);
      if (Number(added) === 1) {
        meta.reports++;
        const cmds: Cmd2[] = [["SET", `lvm:${id}`, JSON.stringify(meta)]];
        if (meta.reports >= HIDE_AFTER_REPORTS) cmds.push(["ZREM", "lv:new", id], ["ZREM", "lv:top", id], ["SADD", "lv:hidden", id]);
        await redis(cmds);
      }
      return Response.json({ enabled: true });
    }
    return Response.json({ error: "bad request" }, { status: 400 });
  } catch {
    return Response.json({ error: "The gallery is unavailable" }, { status: 502 });
  }
}

type Cmd2 = (string | number)[];
