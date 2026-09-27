/**
 * Runs the simulation with the junction event log switched on and checks every junction for
 * incoherent behaviour. Usage:
 *   npm run audit                      -> built-in test networks
 *   npm run audit -- <planId>          -> a plan from the database (DATABASE_URL)
 *   npm run audit -- plan.json         -> a network exported as JSON
 * Options: --seeds=3 --minutes=15 --cars=120
 */
import "./env";
import { readFileSync, existsSync } from "node:fs";
import { compile, conflicts, type Compiled, type Conn, type CNode } from "../src/engine/compile";
import { Sim, type JunctionEvent } from "../src/engine/sim";
import { junctionRefs } from "../src/engine/refs";
import { sampleTown } from "../src/engine/sample";
import { mixedDistrict } from "./junction-audit-net";
import { sanitizeNetwork, sanitizeSettings } from "../src/engine/validate";
import type { Network, PlanSettings } from "../src/engine/types";

const args = process.argv.slice(2);
const opt = (k: string, d: number) => Number(args.find(a => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const SEEDS = opt("seeds", 3), MINUTES = opt("minutes", 15), CARS = opt("cars", 120);
const target = args.find(a => !a.startsWith("--"));

async function loadTarget(): Promise<{ name: string; net: Network; settings: PlanSettings }[]> {
  if (!target) return [
    { name: "demo town", net: sampleTown(), settings: { cars: CARS, trucks: Math.round(CARS / 12), seed: 1 } },
    { name: "mixed district", net: mixedDistrict(), settings: { cars: CARS, trucks: Math.round(CARS / 12), seed: 1 } },
  ];
  if (existsSync(target)) {
    const j = JSON.parse(readFileSync(target, "utf8"));
    return [{ name: target, net: sanitizeNetwork(j.network ?? j), settings: sanitizeSettings(j.settings ?? {}) }];
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const [row] = await sql`select name, network, settings from plans where id = ${target}`;
  await sql.end();
  if (!row) throw new Error(`No plan ${target}`);
  return [{ name: row.name as string, net: sanitizeNetwork(row.network), settings: sanitizeSettings(row.settings) }];
}

// ---------------------------------------------------------------- audit
interface Tally {
  ref: string; control: string; degree: number;
  grants: number; enters: number; leaves: number; denies: Record<string, number>; revokes: number;
  wrongLane: number; turnChanged: number; reroutes: number; towed: number;
  waitSum: number; waitN: number; waitMax: number;
  // violations
  enterOnRed: number; enterWithoutGrant: number; enterBadLane: number; sneaks: number; stuckInside: number; unsafeOverlap: number; giveWayBreach: number;
  perGreen: number[];
}

function audit(name: string, c: Compiled, settings: PlanSettings, seed: number, tallies: Map<string, Tally>) {
  const refs = junctionRefs(c);
  const sim = new Sim(c, { ...settings, seed });
  sim.logAll = true;
  const steps = MINUTES * 600;
  const junctions = c.nodes.filter(n => refs.has(n.def.id));
  for (const n of junctions) if (!tallies.has(n.def.id)) tallies.set(n.def.id, {
    ref: refs.get(n.def.id)!, control: n.ringR ? "roundabout" : n.def.control, degree: n.degree,
    grants: 0, enters: 0, leaves: 0, denies: {}, revokes: 0, wrongLane: 0, turnChanged: 0, reroutes: 0, towed: 0,
    waitSum: 0, waitN: 0, waitMax: 0, enterOnRed: 0, enterWithoutGrant: 0, enterBadLane: 0, sneaks: 0, stuckInside: 0, unsafeOverlap: 0, giveWayBreach: 0, perGreen: [],
  });
  const seenOverlap = new Set<string>();
  for (let i = 0; i < steps; i++) {
    sim.step();
    // physical check: two vehicles inside the same junction on crossing paths at the same time
    if (i % 5 === 0) {
      const inside = new Map<CNode, { id: number; c: Conn }[]>();
      for (const v of sim.vehicles) if (!v.dead && v.piece.kind === "conn" && v.piece.role === "turn" && v.s > 0.5 && v.s < v.piece.len - 0.5) {
        const l = inside.get(v.piece.node) ?? []; l.push({ id: v.id, c: v.piece }); inside.set(v.piece.node, l);
      }
      for (const [node, list] of inside) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        if (!conflicts(list[a].c, list[b].c)) continue;
        const key = `${Math.min(list[a].id, list[b].id)}-${Math.max(list[a].id, list[b].id)}`;
        if (seenOverlap.has(key)) continue;
        seenOverlap.add(key);
        const t = tallies.get(node.def.id); if (t) t.unsafeOverlap++;
      }
    }
  }
  // event-based checks
  const byVeh = new Map<string, JunctionEvent[]>();
  for (const e of sim.events) if (e.veh != null) { const k = `${e.node}#${e.veh}`; const l = byVeh.get(k) ?? []; l.push(e); byVeh.set(k, l); }
  const end = sim.time;
  for (const e of sim.events) {
    const t = tallies.get(e.node); if (!t) continue;
    if (e.kind === "grant") t.grants++;
    else if (e.kind === "enter") { t.enters++; if (e.data?.lane && e.data.lo && (e.data.lane < e.data.lo || e.data.lane > e.data.hi!)) t.enterBadLane++; }
    else if (e.kind === "leave") t.leaves++;
    else if (e.kind === "deny") { const k = e.data?.code ?? "other"; t.denies[k] = (t.denies[k] ?? 0) + 1; }
    else if (e.kind === "revoke") t.revokes++;
    else if (e.kind === "wrong-lane") t.wrongLane++;
    else if (e.kind === "turn-changed") t.turnChanged++;
    else if (e.kind === "reroute") t.reroutes++;
    else if (e.kind === "towed") t.towed++;
  }
  for (const [key, list] of byVeh) {
    const node = key.split("#")[0], t = tallies.get(node); if (!t) continue;
    let lastGrant = -1, lastReq = -1, sneak = false;
    for (const e of list) {
      if (e.kind === "request" && lastReq < 0) lastReq = e.t;
      if (e.kind === "grant") { lastGrant = e.t; sneak = e.detail.includes("clears on the change"); if (lastReq >= 0) { const w = e.t - lastReq; t.waitSum += w; t.waitN++; t.waitMax = Math.max(t.waitMax, w); lastReq = -1; } }
      if (e.kind === "enter") {
        // a permissive turn clearing on the change (granted while waiting at the line) is legal
        if (e.data?.sig === "red" && !sneak) t.enterOnRed++;
        if (sneak) t.sneaks++;
        if (lastGrant < 0 || e.t - lastGrant > 90) t.enterWithoutGrant++;
        const left = list.find(x => x.kind === "leave" && x.t >= e.t);
        if (!left && end - e.t > 40) t.stuckInside++;
        lastGrant = -1; sneak = false;
      }
    }
  }
  for (const n of junctions) if (n.def.control === "lights" && n.phases.length >= 2) {
    const t = tallies.get(n.def.id)!;
    for (const r of sim.lightCycles(n.idx)) if (r && r.history.length) t.perGreen.push(r.avg);
  }
  return { name, seed, stats: sim.stats, events: sim.events.length, sim };
}

(async () => {
  const targets = await loadTarget();
  for (const { name, net, settings } of targets) {
    const c = compile(net);
    const tallies = new Map<string, Tally>();
    const runs = [];
    for (let s = 1; s <= SEEDS; s++) runs.push(audit(name, c, settings, s, tallies));
    console.log(`\n=== ${name}: ${SEEDS} runs × ${MINUTES} min, ${settings.cars} cars ===`);
    for (const r of runs) console.log(`  seed ${r.seed}: avg ${r.stats.avgSpeed.toFixed(1)} km/h, trips/min ${r.stats.tripsPerMin.toFixed(0)}, towed ${r.stats.towed}, ${r.events} events`);
    const rows = [...tallies.values()].sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));
    console.log("  ref  control     in  enters  wait avg/max   denies (reason:count)                     revoke wrongLn turnChg reroute towed | VIOLATIONS red noGrant badLane stuck overlap");
    for (const t of rows) {
      const d = Object.entries(t.denies).map(([k, n]) => `${k}:${n}`).join(" ");
      const viol = [t.enterOnRed, t.enterWithoutGrant, t.enterBadLane, t.stuckInside, t.unsafeOverlap];
      console.log(`  ${t.ref.padEnd(4)} ${t.control.padEnd(10)} ${String(t.degree).padStart(3)} ${String(t.enters).padStart(7)}  ${(t.waitN ? t.waitSum / t.waitN : 0).toFixed(1).padStart(5)}/${t.waitMax.toFixed(0).padStart(4)}s   ${d.padEnd(40).slice(0, 40)} ${String(t.revokes).padStart(6)} ${String(t.wrongLane).padStart(7)} ${String(t.turnChanged).padStart(7)} ${String(t.reroutes).padStart(7)} ${String(t.towed).padStart(5)} | ${viol.map(x => String(x).padStart(3)).join("     ")}${t.sneaks ? `   cleared-on-change ${t.sneaks}` : ""}${t.perGreen.length ? `   cars/green ${t.perGreen.map(x => x.toFixed(1)).join(",")}` : ""}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
