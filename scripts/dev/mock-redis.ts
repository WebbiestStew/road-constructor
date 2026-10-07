// A tiny in-memory stand-in for Upstash's REST API, enough for the leaderboard, gallery and sync routes:
//   npx tsx scripts/dev/mock-redis.ts            (listens on 8079)
//   UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=x npm run dev
import http from "node:http";

const kv = new Map<string, string>();
const sets = new Map<string, Set<string>>();
const zsets = new Map<string, Map<string, number>>();
const ttl = new Map<string, number>();

function z(key: string) {
  return zsets.get(key) ?? zsets.set(key, new Map()).get(key)!;
}
function s(key: string) {
  return sets.get(key) ?? sets.set(key, new Set()).get(key)!;
}

function run(cmd: (string | number)[]): unknown {
  const [name, ...a] = cmd.map((x, i) => (i === 0 ? String(x).toUpperCase() : x));
  const key = String(a[0]);
  switch (name) {
    case "GET":
      return kv.get(key) ?? null;
    case "SET":
      kv.set(key, String(a[1]));
      return "OK";
    case "MGET":
      return a.map((k) => kv.get(String(k)) ?? null);
    case "INCR": {
      const n = Number(kv.get(key) ?? 0) + 1;
      kv.set(key, String(n));
      return n;
    }
    case "EXPIRE":
      ttl.set(key, Date.now() + Number(a[1]) * 1000);
      return 1;
    case "SADD": {
      const set = s(key);
      const had = set.has(String(a[1]));
      set.add(String(a[1]));
      return had ? 0 : 1;
    }
    case "SISMEMBER":
      return s(key).has(String(a[1])) ? 1 : 0;
    case "ZADD": {
      const map = z(key);
      let i = 1;
      let gt = false;
      if (String(a[i]).toUpperCase() === "GT") {
        gt = true;
        i++;
      }
      const score = Number(a[i]);
      const member = String(a[i + 1]);
      if (!gt || !map.has(member) || score > map.get(member)!) map.set(member, score);
      return 1;
    }
    case "ZREM":
      z(key).delete(String(a[1]));
      return 1;
    case "ZCARD":
      return z(key).size;
    case "ZREVRANGE": {
      const withScores = a.some((x) => String(x).toUpperCase() === "WITHSCORES");
      const sorted = [...z(key).entries()].sort((x, y) => y[1] - x[1]);
      const from = Number(a[1]);
      const to = Number(a[2]);
      const slice = sorted.slice(from, to + 1);
      return withScores ? slice.flatMap(([m, sc]) => [m, String(sc)]) : slice.map(([m]) => m);
    }
    case "ZREVRANK": {
      const sorted = [...z(key).entries()].sort((x, y) => y[1] - x[1]).map(([m]) => m);
      const i = sorted.indexOf(String(a[1]));
      return i < 0 ? null : i;
    }
    default:
      throw new Error(`mock redis: unsupported ${name}`);
  }
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const cmds = JSON.parse(body) as (string | number)[][];
        // SET ... EX n
        const out = cmds.map((c) => {
          try {
            if (String(c[0]).toUpperCase() === "SET" && String(c[3] ?? "").toUpperCase() === "EX") ttl.set(String(c[1]), Date.now() + Number(c[4]) * 1000);
            return { result: run(c) };
          } catch (e) {
            return { error: (e as Error).message };
          }
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      } catch {
        res.statusCode = 400;
        res.end("bad");
      }
    });
  })
  .listen(8079, () => console.log("mock redis on 8079"));
