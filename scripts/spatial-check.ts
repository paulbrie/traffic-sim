/**
 * The spatial driving experiment (T213; any junction since ticket #59). Checks, on three sketches from the team's plans:
 * - Roundabout 3 (a drawn junction whose ring is two lanes of a road, not of the junction): found as a roundabout, its island
 *   round, the way round its ring lanes', its carriageway theirs; cars go through it, few collisions;
 * - an oval roundabout (three closed ring lanes of a road): found, not round (route fields take cars round it); cars go through;
 * - plain junctions (Video Demo, no island): each a zone; cars go through them and on along the lanes between them;
 * - route fields: reach every way in of every zone; round an island they only ever lead the ring's way;
 * - a car picked: what it is doing and the path it wants to take;
 * - (ticket #66) cars keep to their route's lanes and connectors as a guide: on it, within a metre of it on average;
 * - (ticket #71) Roundabout 3 as at rev 454: a car at its line sees one coming round the ring (not off along its tangent) and
 *   waits: no collision in the first two and a half minutes (cars 40 and 41 met at 2:28 before).
 * - (ticket #73) Roundabout 3 as at rev 454 (the same sketch as rev 455, the ticket's revision): cars 3 and 4 hold for each
 *   other at 0:28 close enough to look like a collision, but never touch, and don't stay held.
 * npm run spatial:check
 */
import { readFileSync } from "fs";
import { SpatialSim } from "../src/lib/experiments/spatial-roundabout/engine";
import { buildSurface, descend, exitStart, routeField, zoneCell, type Zone } from "../src/lib/experiments/spatial-roundabout/surface";
import { laneById, pointAt, sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";

let failed = 0;
const check = (ok: boolean, what: string) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const load = (f: string) => sanitizeSketch(JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")))!;
const OPTS = { exitLine: true, noBlockBox: true, uturnAfterRound: true };
const run = (sk: Sketch, T: number) => {
  const sim = new SpatialSim(sk, { speed: sk.traffic?.speed ?? 50, rate: sk.traffic?.rate ?? 50, seed: 1, gap: 2, opts: OPTS });
  let picked: ReturnType<SpatialSim["inspect"]> = null, off = 0, n = 0, guided = 0, spatial = 0;
  for (let t = 0; t < T; t += 0.1) {
    sim.step(0.1);
    if (!picked?.guide?.length) { const v = sim.vehicles.find(w => w.mode === "spatial" && w.pathPts && w.guide); if (v) picked = sim.inspect(v.id); }
    // (once a second: how far the cars on their guide (not going round something) are off it)
    if (Math.round(sim.t * 10) % 10 === 0) for (const v of sim.vehicles) if (v.mode === "spatial") {
      spatial++;
      if (!v.guide) continue;
      guided++;
      if (v.offset) continue;
      const q = v.guide.pts[v.guide.k];
      off += Math.hypot(q.x - v.p.x, q.y - v.p.y); n++;
    }
  }
  return { sim, stats: sim.stats(), picked, meanOff: n ? off / n : 0, guidedShare: spatial ? guided / spatial : 0 };
};
/** every way in of a zone (its connectors from lanes not its own) reaches every way out on its route fields (at where a car
 * makes for on the way out, as the engine has it) */
function fieldsReach(sk: Sketch, z: Zone) {
  const ins = sk.connectors.filter(c => z.connectors.has(c.id) && !z.lanes.has(c.from.lane));
  const outs = sk.connectors.filter(c => z.connectors.has(c.id) && !z.lanes.has(c.to.lane));
  let bad = 0;
  for (const o of outs) {
    const l = laneById(sk, o.to.lane)!, D = routeField(z, l, exitStart(z, l, o.to.s));
    for (const i of ins) if (!Number.isFinite(descend(z, D, pointAt(laneById(sk, i.from.lane)!.shape, i.from.s).p, 1).toGo)) bad++;
  }
  return bad;
}

// Roundabout 3
{
  const sk = load("spatial-roundabout-3.json"), s = buildSurface(sk);
  const z = s?.zones.find(x => x.name === "Roundabout 3");
  check(!!z?.island, "Roundabout 3: a roundabout (its ring is a road's lanes, the junction drawn)");
  check(!!z?.island?.polar, "Roundabout 3: its island round");
  check(z?.island?.sense === -1, "Roundabout 3: round the way its ring lanes go (their sweep negative)");
  check(!!z && Math.abs(z.island!.width - 7.0) < 0.6, `Roundabout 3: its carriageway its two ring lanes (${z?.island?.width.toFixed(2)} m)`);
  check(!!z && z.lanes.has("l3245") && z.lanes.has("l3278"), "Roundabout 3: its ring lanes are its own (not ways in or out)");
  check(!!z && fieldsReach(sk, z) === 0, "Roundabout 3: every way in reaches every way out on the route fields");
  // (from a point on the ring, down the field to a way out across the ring: always the ring's way)
  if (z?.island) {
    const out = sk.connectors.find(c => z.connectors.has(c.id) && !z.lanes.has(c.to.lane))!, D = routeField(z, laneById(sk, out.to.lane)!, out.to.s);
    const isl = z.island, r = isl.width / 2 + 5.4, g = pointAt(laneById(sk, out.to.lane)!.shape, out.to.s).p, ga = Math.atan2(g.y - isl.c.y, g.x - isl.c.x);
    let against = 0;
    for (let a = 0; a < 360; a += 15) {
      const p = { x: isl.c.x + r * Math.cos((a * Math.PI) / 180), y: isl.c.y + r * Math.sin((a * Math.PI) / 180) }, q = descend(z, D, p, 2);
      // (beside the way out the field leads out across the ring, not round it)
      if (!q.aim || Math.cos((a * Math.PI) / 180 - ga) > Math.cos(Math.PI / 6)) continue;
      const turn = Math.atan2(q.aim.y - isl.c.y, q.aim.x - isl.c.x) - Math.atan2(p.y - isl.c.y, p.x - isl.c.x);
      if (Math.sin(turn) * isl.sense < -0.01) against++;
    }
    check(against === 0, `Roundabout 3: its route fields never lead against the ring (${against} places do)`);
  }
  const { stats, picked, meanOff, guidedShare } = run(sk, 240);
  check(stats.finished >= 15, `Roundabout 3: cars through in 4 min (${stats.finished})`);
  check(guidedShare > 0.9, `Roundabout 3: cars keep to a guide by its lanes and connectors (${Math.round(guidedShare * 100)}% of the time)`);
  check(meanOff < 1, `Roundabout 3: on their guide, within a metre of it (${meanOff.toFixed(2)} m on average)`);
  check(!!picked?.guide && picked.guide.length > 5, "a car picked: its guide through the junction");
  check(stats.collisions <= 5, `Roundabout 3: few collisions (${stats.collisions})`);
  check(!!picked && picked.path.length > 5 && !!picked.goal && picked.doing.includes("Roundabout 3"), `a car picked: its path ahead and its way out (${picked?.doing})`);
}

// Roundabout 3 at rev 454: cars 40 and 41 (ticket #71)
{
  const sk = load("spatial-roundabout-3-rev454.json");
  const sim = new SpatialSim(sk, { speed: sk.traffic?.speed ?? 50, rate: sk.traffic?.rate ?? 50, seed: sk.traffic?.seed ?? 1, gap: 2, opts: OPTS });
  for (let t = 0; t < 152; t += 0.1) sim.step(0.1);
  const st = sim.stats();
  check(st.collisions === 0, `Roundabout 3 (rev 454): no collision in the first 2:32, cars going in wait for one coming round (${st.collisions})`);
  check(st.finished >= 30, `Roundabout 3 (rev 454): cars through in 2:32 (${st.finished})`);
}

// an oval roundabout
{
  const sk = load("spatial-oval.json"), s = buildSurface(sk), z = s?.zones.find(x => x.island);
  check(!!z, "the oval: a roundabout");
  check(!!z && !z.island!.polar, "the oval: not round, driven round by route fields");
  check(!!z && fieldsReach(sk, z) === 0, "the oval: every way in reaches every way out on the route fields");
  const { stats } = run(sk, 240);
  check(stats.finished >= 5, `the oval: cars through in 4 min (${stats.finished})`);
}

// plain junctions
{
  const sk = load("spatial-plain.json"), s = buildSurface(sk), plain = s?.zones.filter(x => !x.island) ?? [];
  check(plain.length >= 4, `Video Demo: its plain junctions are zones (${plain.length})`);
  check(plain.every(z => fieldsReach(sk, z) === 0), "Video Demo: every way in reaches every way out on the route fields");
  check(plain.every(z => zoneCell(z, z.outline[0]) >= 0), "Video Demo: each zone's grid takes in its border");
  const { stats, meanOff } = run(sk, 240);
  check(stats.finished >= 15, `Video Demo: cars through its junctions in 4 min (${stats.finished})`);
  check(meanOff < 1, `Video Demo: on their guide, within a metre of it (${meanOff.toFixed(2)} m on average)`);
  check(stats.collisions <= 8, `Video Demo: few collisions (${stats.collisions})`);
}

// Roundabout 3 at rev 454 again: cars 3 and 4 at 0:28, a near miss reported as a collision (ticket #73)
{
  const sk = load("spatial-roundabout-3-rev454.json");
  const sim = new SpatialSim(sk, { speed: sk.traffic?.speed ?? 50, rate: sk.traffic?.rate ?? 50, seed: 1, gap: 2, opts: OPTS });
  let held = false, heldPast35 = false;
  for (let t = 0; t < 40; t += 0.1) {
    sim.step(0.1);
    const a = sim.vehicles.find(v => v.id === 3), b = sim.vehicles.find(v => v.id === 4);
    if (a?.v === 0 && b?.v === 0 && a.limit?.startsWith("car") && b.limit?.startsWith("car")) held = true;
    if (t > 35 && (a?.v ?? 1) < 0.1 && (b?.v ?? 1) < 0.1) heldPast35 = true;
  }
  const st = sim.stats();
  // (informational, not a check: #72 changes the ring queue ahead of this moment, so cars 3 and 4 may no
  // longer reach it at all — that's fine, the two checks below are what must hold either way)
  console.log(`${held ? "ok  " : "note"} Roundabout 3 (rev 454): cars 3 and 4 hold for each other near 0:28 (${held ? "reproduces the ticket's moment" : "moment no longer happens"})`);
  check(st.collisions === 0, `Roundabout 3 (rev 454): cars 3 and 4 never touch (${st.collisions})`);
  check(!heldPast35, "Roundabout 3 (rev 454): cars 3 and 4's hold clears within a few seconds, not stuck");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
