// Measures the unchanged real cities the way their star lines are set: the mean of eight seeds, with the service numbers.
// npx tsx scripts/sim/baseline.ts [--noyield] [key ...]   (--noyield measures with left turns that do not give way, to compare)       (several runs at once; the results do not depend on how busy the machine is)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REAL_PLANS } from "../../src/sim/scenarios";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const noYield = args.includes("--noyield");
const keys = args.filter((a) => !a.startsWith("--"));
const plans = REAL_PLANS.filter((p) => keys.length === 0 || keys.includes(p.key));
const SEEDS = [1337, 1, 2, 3, 4, 5, 6, 7];
const PARALLEL = 4;

interface One {
  trips: number;
  delayShare: number | null;
  queueFt: number;
}

async function one(key: string, seed: number): Promise<One> {
  const { stdout } = await exec("npx", ["tsx", "scripts/sim/run.ts", key, noYield ? "noyield" : "none", String(seed)], { maxBuffer: 1 << 24 });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

async function main() {
  const jobs = plans.flatMap((p) => SEEDS.map((seed) => ({ key: p.key, seed })));
  const results = new Map<string, One[]>();
  let next = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const r = await one(job.key, job.seed);
        (results.get(job.key) ?? results.set(job.key, []).get(job.key)!).push(r);
      }
    })
  );
  for (const p of plans) {
    const rs = results.get(p.key)!;
    const trips = rs.map((r) => r.trips);
    const mean = trips.reduce((a, b) => a + b, 0) / trips.length;
    const delays = rs.map((r) => r.delayShare).filter((d): d is number => d !== null);
    const delay = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null;
    const queue = rs.reduce((a, b) => a + b.queueFt, 0) / rs.length;
    console.log(
      JSON.stringify({ key: p.key, current: p.baseline, baseline: Math.round(mean), min: Math.min(...trips), max: Math.max(...trips), delayShare: delay === null ? null : +delay.toFixed(3), queueFt: Math.round(queue), noYield })
    );
  }
}
void main();
