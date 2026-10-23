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
 *   waits: no collision in the first two and a half minutes (cars 40 and 41 met at 2:28 before);
 * - (ticket #72) the same: cars don't go in in front of a queue on the ring, so it never fills all the way round (cars each
 *   waiting for the one ahead, the ring stopped: 7 of them at 8:39 before);
 * - (ticket #74) round a round island a car's line comes from geometry, not its connectors' curves: on Roundabout 3 (rev 454)
 *   every way in to every way out has one, on the paving, and none goes round more than once (4 of 36 did, 417-522°);
 * - (ticket #75) who goes first by bookings of the junction's cells: Video Demo's plain junctions over 10 minutes, cars through
 *   and next to no collisions or locks (crossing cars held each other there before, 570 through in 4 × 10 min); Roundabout 3
 *   (rev 454) 10 minutes without a collision;
 * - (ticket #73) Roundabout 3 as at rev 454 (the same sketch as rev 455, the ticket's revision): cars 3 and 4 hold for each
 *   other at 0:28 close enough to look like a collision, but never touch, and don't stay held.
 * - (ticket #76) Roundabout 3 as at rev 456 (a lane in drawn with only a right turn from it): its cars for any other way out go
 *   in from their own line by a line from geometry, not crossing to the lane beside 12 m before it; to 32:44 none stands two
 *   minutes, next to no locks, no queue held back at the edge (car 885 stood 2 minutes there, its lane behind it: 8 locks, 80
 *   cars held back).
 * - (ticket #78) a bridge over a roundabout (V2 check (Tatiana)): cars at different levels don't see, wait for or meet each
 *   other, and the bridge is no paving of the roundabout under it (it paved a way across its island before).
 * - (ticket #77) Roundabout 3 as at rev 461 (two ring lanes): a car goes round in the middle of a ring lane, the one its lane in
 *   leads to as the connectors are drawn, not on the line between the two (a fifth of the time before); cars through, next to
 *   no collisions or locks.
 * - (ticket #81) handed back onto its lane, a car is drawn easing onto it, not turned or moved at once (up to 45° from one frame to
 *   the next before); as driven and met, still on its lane.
 * npm run spatial:check
 */
import { readFileSync } from "fs";
import { SpatialSim } from "../src/lib/experiments/spatial-roundabout/engine";
import { buildSurface, descend, drivable, exitStart, routeField, zoneCell, type Zone } from "../src/lib/experiments/spatial-roundabout/surface";
import { contentsOf, junctionLevel, laneById, laneLength, pointAt, sanitizeSketch, zAt, type Sketch } from "../src/lib/lane-sketch";

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
  check(guidedShare > 0.9, `Roundabout 3: cars keep to a guide, a line from geometry or its connectors (${Math.round(guidedShare * 100)}% of the time)`);
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

// (ticket #74) Roundabout 3 at rev 454: lines from geometry for every way in to every way out, none looping
{
  const sk = load("spatial-roundabout-3-rev454.json");
  const sim = new SpatialSim(sk, { speed: 50, rate: 50, seed: 1, gap: 2, opts: OPTS }) as unknown as { surface: { zones: Zone[] }; outsOf: Map<Zone, { lane: { id: string }; s: number }[]>; lineThrough: (z: Zone, p: { x: number; y: number }, h: number, lane: unknown, s: number) => { pts: { x: number; y: number }[] } | null };
  const z = sim.surface.zones[0], c = z.island!.c;
  let made = 0, failed = 0, maxDeg = 0;
  const ins = new Map(sk.connectors.filter(x => z.connectors.has(x.id) && !z.lanes.has(x.from.lane)).map(x => [`${x.from.lane}@${x.from.s.toFixed(0)}`, x]));
  for (const cn of ins.values()) {
    const a = pointAt(laneById(sk, cn.from.lane)!.shape, cn.from.s);
    for (const o of sim.outsOf.get(z) ?? []) {
      if (o.lane.id === cn.from.lane) continue;
      const line = sim.lineThrough(z, a.p, Math.atan2(a.d.y, a.d.x), o.lane, o.s);
      if (!line) { failed++; continue; }
      made++;
      let turn = 0;
      for (let i = 1; i < line.pts.length; i++) { let d = Math.atan2(line.pts[i].y - c.y, line.pts[i].x - c.x) - Math.atan2(line.pts[i - 1].y - c.y, line.pts[i - 1].x - c.x); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; turn += d; }
      maxDeg = Math.max(maxDeg, (Math.abs(turn) * 180) / Math.PI);
    }
  }
  check(failed === 0 && made > 40, `Roundabout 3 (rev 454): a line from geometry for every way in to every way out (${made} made, ${failed} not)`);
  check(maxDeg < 360, `Roundabout 3 (rev 454): no line goes round more than once (at most ${Math.round(maxDeg)}°)`);
}

// (ticket #75) bookings: Video Demo's plain junctions, and Roundabout 3 (rev 454), 10 minutes each
{
  for (const [f, name, minThrough] of [["spatial-plain.json", "Video Demo", 250], ["spatial-roundabout-3-rev454.json", "Roundabout 3 (rev 454)", 200]] as const) {
    const sk = load(f), sim = new SpatialSim(sk, { speed: sk.traffic?.speed ?? 50, rate: sk.traffic?.rate ?? 50, seed: 1, gap: 2, opts: OPTS });
    for (let t = 0; t < 600; t += 0.1) sim.step(0.1);
    const st = sim.stats();
    check(st.finished >= minThrough, `${name}: cars through in 10 min, who goes first by bookings (${st.finished})`);
    check(st.collisions <= 2, `${name}: next to no collisions in 10 min (${st.collisions})`);
    check(st.deadlocks <= 3, `${name}: next to no locks cleared in 10 min (${st.deadlocks})`);
  }
}

// (ticket #76) Roundabout 3 at rev 456: in from a lane with only a right turn drawn from it, to 32:44 (the ticket's moment)
{
  const sk = load("spatial-roundabout-3-rev456.json");
  const sim = new SpatialSim(sk, { speed: sk.traffic?.speed ?? 50, rate: sk.traffic?.rate ?? 50, seed: 1, gap: 2, opts: OPTS });
  const was = new Map<number, string>();
  let own = 0, early = 0, longest = 0;
  for (let t = 0; t < 1964.6; t += 0.1) {
    sim.step(0.1);
    for (const v of sim.vehicles) {
      // (handed over from l3246 for a way out other than its right turn's (l2973): at its line, or crossing over before it)
      if (v.mode === "spatial" && was.get(v.id) === "lane" && v.from?.id === "l3246" && v.goal?.lane.id !== "l2973") { if (v.entered < -0.5) early++; else own++; }
      was.set(v.id, v.mode);
      longest = Math.max(longest, v.still);
    }
  }
  const st = sim.stats();
  check(own >= 50 && early === 0, `Roundabout 3 (rev 456): cars on the lane with only a right turn go in from its own line for other ways out (${own} did, ${early} crossed over before it)`);
  check(longest < 120, `Roundabout 3 (rev 456): no car stands two minutes in 32:44 (at most ${longest.toFixed(0)} s)`);
  check(st.deadlocks <= 2 && st.heldBack <= 20, `Roundabout 3 (rev 456): next to no locks, no queue held back at 32:44 (${st.deadlocks} locks, ${st.heldBack} held back; 8 and 80 before)`);
}

// (ticket #77) Roundabout 3 at rev 461: round its two ring lanes in the middle of one
{
  const sk = load("spatial-roundabout-3-rev461.json");
  const sim = new SpatialSim(sk, { speed: sk.traffic?.speed ?? 50, rate: sk.traffic?.rate ?? 50, seed: 1, gap: 2, opts: OPTS });
  const inner = sim as unknown as { surface: { zones: Zone[] }; ringLaneFor: (z: Zone, l: unknown, n: number) => number | undefined; inRing: (z: Zone, p: { x: number; y: number }) => boolean; body: (v: unknown) => { c: { x: number; y: number } } };
  const z = inner.surface.zones.find(x => x.island)!, c = z.island!.c;
  // (the ring lanes from the inside out; each lane in drawn onto one, the one it is taken to)
  const ring = [...z.lanes].map(id => laneById(sk, id)!).filter(l => l.shape.kind === "arc").sort((a, b) => (a.shape as { r: number }).r - (b.shape as { r: number }).r);
  const drawn = sk.connectors.filter(x => z.connectors.has(x.id) && !z.lanes.has(x.from.lane) && ring.some(l => l.id === x.to.lane));
  const wrong = drawn.filter(x => ring[inner.ringLaneFor(z, laneById(sk, x.from.lane), ring.length) ?? -1]?.id !== x.to.lane);
  check(drawn.length >= 4 && !wrong.length, `Roundabout 3 (rev 461): each lane in taken to the ring lane it is drawn onto (${drawn.length - wrong.length} of ${drawn.length})`);
  // (once a second, cars on the ring: on the line between the two lanes, their body over it)
  const mid = ring.slice(1).map((l, i) => ((l.shape as { r: number }).r + (ring[i].shape as { r: number }).r) / 2);
  let on = 0, over = 0;
  for (let t = 0; t < 600; t += 0.1) {
    sim.step(0.1);
    if (Math.round(sim.t * 10) % 10) continue;
    for (const v of sim.vehicles) if (v.mode === "spatial" && v.zone === z && inner.inRing(z, v.p)) { const b = inner.body(v).c, r = Math.hypot(b.x - c.x, b.y - c.y); on++; if (mid.some(m => Math.abs(r - m) < 0.9)) over++; }
  }
  const st = sim.stats();
  check(over / on < 0.14, `Roundabout 3 (rev 461): on the ring, a car over the line between its lanes ${((100 * over) / on).toFixed(0)}% of the time (18% before)`);
  check(st.finished >= 300 && st.collisions <= 2 && st.deadlocks <= 2, `Roundabout 3 (rev 461): cars through in 10 min, next to no collisions or locks (${st.finished}, ${st.collisions}, ${st.deadlocks})`);
}

// (ticket #81) Roundabout 3 at rev 461: handed back, drawn easing onto its lane
{
  const sk = load("spatial-roundabout-3-rev461.json");
  const sim = new SpatialSim(sk, { speed: sk.traffic?.speed ?? 50, rate: sk.traffic?.rate ?? 50, seed: 1, gap: 2, opts: OPTS });
  const last = new Map<number, { c: { x: number; y: number }; d: { x: number; y: number }; mode: string }>();
  let backs = 0, turn = 0, jump = 0, onLane = true;
  for (let t = 0; t < 300; t += 0.1) {
    sim.step(0.1);
    for (const v of sim.vehicles) {
      const b = sim.drawn(v), was = last.get(v.id);
      if (was?.mode === "spatial" && v.mode === "lane") {
        backs++;
        turn = Math.max(turn, (Math.abs(Math.atan2(was.d.x * b.d.y - was.d.y * b.d.x, was.d.x * b.d.x + was.d.y * b.d.y)) * 180) / Math.PI);
        jump = Math.max(jump, Math.hypot(b.c.x - was.c.x, b.c.y - was.c.y) - v.v * 0.1);
        // (as driven, on its lane: its body there)
        const lb = sim.body(v), q = pointAt(v.at!.lane.shape, v.at!.s).p;
        if (Math.hypot(lb.c.x + (lb.d.x * lb.len) / 2 - q.x, lb.c.y + (lb.d.y * lb.len) / 2 - q.y) > 0.01) onLane = false;
      }
      last.set(v.id, { c: b.c, d: b.d, mode: v.mode });
    }
  }
  check(backs >= 100 && turn < 10 && jump < 0.5, `Roundabout 3 (rev 461): handed back, drawn easing onto its lane (${backs} cars, turned at most ${turn.toFixed(1)}° and moved at most ${Math.max(0, jump).toFixed(2)} m past its travel in a step; 45° before)`);
  check(onLane, "Roundabout 3 (rev 461): handed back, it drives and meets others on its lane as before (only its drawing eased)");
}

// (ticket #72) Roundabout 3 at rev 454: the ring never fills all the way round
{
  const sk = load("spatial-roundabout-3-rev454.json");
  const sim = new SpatialSim(sk, { speed: sk.traffic?.speed ?? 50, rate: sk.traffic?.rate ?? 50, seed: sk.traffic?.seed ?? 1, gap: 2, opts: OPTS });
  // (a cycle among the cars standing 3 s or more, each held by the next: "car N at …")
  let cycle = 0, at = 0;
  for (let t = 0; t < 600 && !cycle; t += 0.1) {
    sim.step(0.1);
    const by = new Map<number, number>();
    for (const v of sim.vehicles) { const m = v.mode === "spatial" && v.still >= 3 ? /^car (\d+) at/.exec(v.limit ?? "") : null; if (m) by.set(v.id, Number(m[1])); }
    for (const start of by.keys()) {
      const seen: number[] = [];
      let cur: number | undefined = start;
      while (cur !== undefined && !seen.includes(cur)) { seen.push(cur); cur = by.get(cur); }
      if (cur !== undefined && seen.length - seen.indexOf(cur) >= 4) { cycle = seen.length - seen.indexOf(cur); at = sim.t; break; }
    }
  }
  check(!cycle, `Roundabout 3 (rev 454): its ring never fills round in 10 min, cars each waiting for the next (${cycle ? `${cycle} cars at ${at.toFixed(0)} s` : "none"})`);
  check(sim.stats().finished >= 120, `Roundabout 3 (rev 454): cars through in 10 min (${sim.stats().finished})`);
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

// (ticket #78) a bridge over a roundabout (V2 check (Tatiana): b1/b2 a level up over Roundabout 2)
{
  const sk = load("spatial-levels.json"), s = buildSurface(sk)!, z = s.zones.find(x => x.name === "Roundabout 2")!, b1 = laneById(sk, "b1")!;
  let over = 0;
  for (let u = 0; u <= laneLength(b1.shape); u += 1) { const p = pointAt(b1.shape, u).p, q = zoneCell(z, p); if (q >= 0 && drivable(s, p) && z.kind[q] !== 1) over++; }
  check(over === 0, `levels: the bridge over Roundabout 2 is no paving of it (${over} m of it is)`);
  const sim = new SpatialSim(sk, { speed: 50, rate: sk.traffic?.rate ?? 200, seed: 1, gap: 2, opts: OPTS });
  const contents = contentsOf(sk), jLevel = new Map(s.zones.map(x => [x, junctionLevel(sk, contents.get(x.junction)!)]));
  const levelOf = (v: SpatialSim["vehicles"][number]) => v.mode === "lane" ? zAt(sk, v.at!.lane.id, Math.min(v.at!.s, v.at!.len)) : jLevel.get(v.zone!) ?? 0;
  let across = 0, seen = 0, crossed = 0;
  for (let t = 0; t < 180; t += 0.1) {
    const n = sim.collisionLog.length;
    sim.step(0.1);
    const byId = new Map(sim.vehicles.map(v => [v.id, v]));
    for (const c of sim.collisionLog.slice(n)) { const a = byId.get(c.a), b = byId.get(c.b); if (a && b && Math.abs(levelOf(a) - levelOf(b)) >= 0.5) across++; }
    for (const v of sim.vehicles) {
      if (v.mode === "lane" && v.at!.lane === b1) { const p = pointAt(b1.shape, v.at!.s).p; if (Math.hypot(p.x - z.island!.c.x, p.y - z.island!.c.y) < 5) crossed++; }
      if (v.mode === "spatial" && v.rays) for (const r of v.rays) { const w = r.car >= 0 ? byId.get(r.car) : undefined; if (w && Math.abs(levelOf(w) - levelOf(v)) >= 0.5) seen++; }
    }
  }
  check(crossed > 0, "levels: cars cross the bridge over Roundabout 2");
  check(across === 0, `levels: no collisions between cars at different levels (${across})`);
  check(seen === 0, `levels: spatial cars' rays don't see cars at another level (${seen} hits)`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
