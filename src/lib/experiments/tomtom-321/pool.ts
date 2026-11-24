/**
 * Runs jobs in worker processes (scripts/tomtom-321-worker.ts), `n` at a time (ticket #321). Node-only.
 */
import { spawn } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { DemandMatrix } from "../../lane-sketch";
import type { RunOpts, WayStat } from "./sim";

export interface Job { sketch: string; matrix: DemandMatrix; opts: RunOpts; area?: string[] }
export interface JobOut {
  ways: Record<string, WayStat>; byIn: Record<string, Record<string, number>>; byOut: Record<string, Record<string, number>>;
  trips: number; tripTime: number; onMap: number; collisions: number; deadlocks: number; waiting: number; areaKm: number; areaHours: number; areaDelay: number; ms: number;
}

const ROOT = join(__dirname, "../../../..");
let seq = 0;

export async function runAll(jobs: Job[], n: number, tmp = "/tmp/t321/jobs"): Promise<JobOut[]> {
  mkdirSync(tmp, { recursive: true });
  const out: JobOut[] = new Array(jobs.length);
  let next = 0;
  const one = (i: number) => new Promise<void>((ok, fail) => {
    const id = `${process.pid}-${++seq}`, jf = join(tmp, `${id}.job.json`), of = join(tmp, `${id}.out.json`);
    writeFileSync(jf, JSON.stringify(jobs[i]));
    const p = spawn(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "scripts/tomtom-321-worker.ts"), jf, of], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", d => (err += d));
    p.on("exit", code => {
      if (code !== 0) return fail(new Error(`job ${i} failed (${code}): ${err.slice(-2000)}`));
      out[i] = JSON.parse(readFileSync(of, "utf8"));
      ok();
    });
  });
  const lane = async () => { while (next < jobs.length) { const i = next++; await one(i); } };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, lane));
  return out;
}
