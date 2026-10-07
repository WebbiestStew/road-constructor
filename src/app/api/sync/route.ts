import type { NextRequest } from "next/server";
import { clientIp, rateLimited, redis, redisConfigured, sha256Hex } from "@/lib/server/redis";

/**
 * Backing up saves between devices without accounts. A sync code (generated on the device, 16 characters) is the whole
 * identity: the server stores the player's saves under a hash of it, so it never holds the code itself, and whoever
 * has the code can read and replace that backup. Backups expire after six months without being touched.
 */

const CODE_RE = /^[A-Z2-7]{16}$/;
const MAX_BLOB_CHARS = 1_800_000;
const TTL_S = 60 * 60 * 24 * 180;

export async function GET() {
  return Response.json({ enabled: redisConfigured() });
}

export async function POST(request: NextRequest) {
  if (!redisConfigured()) return Response.json({ enabled: false }, { status: 503 });
  const text = await request.text();
  if (text.length > MAX_BLOB_CHARS + 200) return Response.json({ error: "That backup is too big" }, { status: 413 });
  let body: { action?: unknown; code?: unknown; blob?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const code = String(body.code ?? "");
  if (!CODE_RE.test(code)) return Response.json({ error: "That code doesn't look right" }, { status: 400 });
  try {
    if (await rateLimited("sync", clientIp(request), 30, 3600)) return Response.json({ error: "Slow down a little" }, { status: 429 });
    const key = `sync:${await sha256Hex(code)}`;
    if (body.action === "put") {
      const blob = typeof body.blob === "string" ? body.blob : "";
      if (blob.length < 10 || blob.length > MAX_BLOB_CHARS) return Response.json({ error: "That backup is too big" }, { status: 413 });
      await redis([["SET", key, JSON.stringify({ blob, at: Date.now() }), "EX", TTL_S]]);
      return Response.json({ enabled: true, at: Date.now() });
    }
    if (body.action === "get") {
      const [raw] = await redis([["GET", key]]);
      if (!raw) return Response.json({ error: "No backup under that code" }, { status: 404 });
      await redis([["EXPIRE", key, TTL_S]]);
      const parsed = JSON.parse(String(raw)) as { blob: string; at: number };
      return Response.json({ enabled: true, blob: parsed.blob, at: parsed.at });
    }
    return Response.json({ error: "bad request" }, { status: 400 });
  } catch {
    return Response.json({ error: "The backup service is unavailable" }, { status: 502 });
  }
}
