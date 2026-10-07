/**
 * Server-side Redis over Upstash's REST API (the same optional store the leaderboard uses). With no URL and token in the
 * environment every endpoint reports `enabled: false` and the game hides the feature, so the site works without it.
 */

const URL_ENV = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const TOKEN_ENV = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

export type Cmd = (string | number)[];

export function redisConfigured(): boolean {
  return !!URL_ENV && !!TOKEN_ENV;
}

/** Runs commands in one round trip and returns each result. */
export async function redis(commands: Cmd[]): Promise<unknown[]> {
  const res = await fetch(`${URL_ENV}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_ENV}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const rows = (await res.json()) as { result?: unknown; error?: string }[];
  const failed = rows.find((r) => r.error);
  if (failed) throw new Error(`redis: ${failed.error}`);
  return rows.map((r) => r.result);
}

/** True when this caller has used up `limit` actions of kind `bucket` in the last `windowS` seconds (and counts this one). */
export async function rateLimited(bucket: string, who: string, limit: number, windowS: number): Promise<boolean> {
  const key = `rl:${bucket}:${who}`;
  const [count] = await redis([["INCR", key], ["EXPIRE", key, windowS]]);
  return Number(count) > limit;
}

export function clientIp(request: Request): string {
  return (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
}

/** Obvious slurs and the like: a small net, not moderation. */
export const BLOCKED = /(fuck|shit|cunt|nigg|fagg|bitch|rape|nazi|hitler|porn|nsfw)/i;

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
