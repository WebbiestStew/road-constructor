// Measures the service numbers (trip delay share, longest queue) of every hand-built level left untouched, over three seeds.
// npx tsx scripts/sim/service.ts [levelId ...]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SCENARIOS } from "../../src/sim/scenarios";

const exec = promisify(execFile);
const only = process.argv.slice(2);
const levels = SCENARIOS.filter((s) => !s.real && (only.length === 0 || only.includes(s.id)));
const SEEDS = [1337, 1, 2];
const PARALLEL = 4;

interface One {
  trips: number;
  delayShare: number | null;
  queueFt: number;
}

async function one(id: string, seed: number): Promise<One | null> {
  try {
    const { stdout } = await exec("npx", ["tsx", "scripts/sim/level.ts", id, "none", String(seed)], { maxBuffer: 1 << 24 });
    return JSON.parse(stdout.trim().split("\n").pop()!);
  } catch {
    return null;
  }
}

async function main() {
  const jobs = levels.flatMap((l) => SEEDS.map((seed) => ({ id: l.id, seed })));
  const results = new Map<string, One[]>();
  let next = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const r = await one(job.id, job.seed);
        if (r) (results.get(job.id) ?? results.set(job.id, []).get(job.id)!).push(r);
      }
    })
  );
  for (const l of levels) {
    const rs = results.get(l.id) ?? [];
    if (rs.length === 0) {
      console.log(JSON.stringify({ id: l.id, error: "no result" }));
      continue;
    }
    const delays = rs.map((r) => r.delayShare).filter((d): d is number => d !== null);
    console.log(
      JSON.stringify({
        id: l.id,
        trips: Math.round(rs.reduce((a, b) => a + b.trips, 0) / rs.length),
        delayShare: delays.length ? +(delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(3) : null,
        queueFt: Math.round(rs.reduce((a, b) => a + b.queueFt, 0) / rs.length),
      })
    );
  }
}
void main();
