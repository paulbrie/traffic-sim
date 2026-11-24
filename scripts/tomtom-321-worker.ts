/**
 * One headless run for ticket #321 (scripts/tomtom-321.ts starts these, several at once): reads a job (a sketch file,
 * the demand matrix, seed and minutes), runs it (src/lib/experiments/tomtom-321/sim.ts) and writes what came of it.
 *   npx tsx scripts/tomtom-321-worker.ts <job.json> <out.json>
 */
import { readFileSync, writeFileSync } from "fs";
import { sanitizeSketch, type DemandMatrix } from "../src/lib/lane-sketch";
import { run, withMatrix, type RunOpts } from "../src/lib/experiments/tomtom-321/sim";

const [jobFile, outFile] = process.argv.slice(2);
const job = JSON.parse(readFileSync(jobFile, "utf8")) as { sketch: string; matrix: DemandMatrix; opts: RunOpts; area?: string[] };
const sk = sanitizeSketch(JSON.parse(readFileSync(job.sketch, "utf8")))!;
const r = run(withMatrix(sk, job.matrix, job.opts.warmupMin), job.opts, job.area ? new Set(job.area) : undefined);
writeFileSync(outFile, JSON.stringify({ ...r, ways: Object.fromEntries(r.ways) }));
