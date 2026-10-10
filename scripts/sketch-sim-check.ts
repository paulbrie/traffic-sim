/**
 * Runs a V2 plan's lane sketch headlessly and counts what went wrong, per seed:
 *   npx tsx scripts/sketch-sim-check.ts <planId | sketch.json> [seconds=900] [seeds=1,2,3]
 * A plan id is read (only read) from the app's database in .env.local, which must be `railway`; the sketch is kept in
 * /tmp/sketch-<planId>.json for the next run (delete it to read the plan again). The run uses the sketch's own traffic
 * (rate, speed, settings), stepped 0.1 s at a time. SIM=<module> runs another copy of the sim (to compare with HEAD's).
 * Prints, per seed: deadlocks broken, collisions, cars stuck at the end, vehicles in and out, arrivals held back; then
 * where the deadlocks and collisions were (by junction, else by lane); VERBOSE=1 lists each one.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import postgres from "postgres";
import { settle, contentsOf, sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";
import * as current from "../src/lib/lane-sketch-sim";

async function load(arg: string): Promise<Sketch> {
  if (arg.endsWith(".json")) return JSON.parse(readFileSync(arg, "utf8"));
  const cache = `/tmp/sketch-${arg}.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const url = /^DATABASE_URL=(.*)$/m.exec(readFileSync(".env.local", "utf8"))![1].trim();
  const s = postgres(url, { max: 1 });
  try {
    const [{ d }] = await s`select current_database() as d`;
    if (d !== "railway") throw new Error(`database is ${d}, not railway: stop`);
    const [p] = await s`select name, revision, sketch from plans where id = ${arg}`;
    if (!p?.sketch) throw new Error(`no plan ${arg} with a sketch`);
    console.log(`${p.name}, revision ${p.revision}`);
    writeFileSync(cache, JSON.stringify(p.sketch));
    return p.sketch;
  } finally { await s.end(); }
}

async function main() {
  const [arg, secs = "900", seedList = "1,2,3"] = process.argv.slice(2);
  if (!arg) { console.log("usage: sketch-sim-check.ts <planId | sketch.json> [seconds] [seeds]"); process.exit(1); }
  const { SketchSim, DEFAULT_SIM } = (process.env.SIM ? await import(resolve(process.env.SIM)) : current) as typeof current;
  const sk = settle(sanitizeSketch(await load(arg))!), T = Number(secs);
  const cs = contentsOf(sk), onJ = new Map<string, string>();
  for (const j of sk.junctions) for (const id of [...(cs.get(j.id)?.connectors ?? []), ...(cs.get(j.id)?.lanes ?? [])]) onJ.set(id, j.id);
  const where = (edge: string) => { const id = edge.split(":")[1] ?? edge; return onJ.get(id) ?? id; };
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k}:${n}`).join(" ") || "-";
  for (const seed of seedList.split(",").map(Number)) {
    const sim = new SketchSim(sk, { ...(sk.traffic ?? DEFAULT_SIM), seed }, seed);
    // (every problem counted, not just the last ones kept for the console)
    const all: current.SimProblem[] = [], s = sim as unknown as { problem: (...a: unknown[]) => void; problemList: current.SimProblem[] }, was = s.problem.bind(sim);
    s.problem = (...a: unknown[]) => { was(...a); all.push(s.problemList[s.problemList.length - 1]); };
    const t0 = performance.now();
    while (sim.t < T - 1e-9) sim.step(Math.min(0.1, T - sim.t));
    const st = sim.stats(), by = (kind: string) => { const m = new Map<string, number>(); for (const p of all) if (p.kind === kind) m.set(where(p.edge), (m.get(where(p.edge)) ?? 0) + 1); return m; };
    const stuck = new Map<string, number>(); for (const c of sim.problems().stuck) stuck.set(where(c.edge), (stuck.get(where(c.edge)) ?? 0) + 1);
    console.log(`seed ${seed}, ${T} s (${((performance.now() - t0) / 1000).toFixed(0)} s to run): deadlocks ${st.deadlocks}, collisions ${st.collisions}, stuck ${st.stuck}, in ${st.spawned}, out ${st.finished}, held back ${st.heldBack}`);
    console.log(`  deadlocks at ${top(by("deadlock"))}`);
    console.log(`  collisions at ${top(by("collision"))}`);
    console.log(`  stuck at ${top(stuck)}`);
    if (process.env.VERBOSE) for (const p of all) if (p.kind === "deadlock" || p.kind === "collision") console.log(`  ${p.t} ${p.kind} ${where(p.edge)} ${p.edge} car ${p.car}${p.other !== undefined ? `/${p.other}` : ""}: ${p.detail}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
