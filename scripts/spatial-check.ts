/**
 * The spatial driving experiment (T213; any junction since ticket #59). Checks, on three sketches from the team's plans:
 * - Roundabout 3 (a drawn junction whose ring is two lanes of a road, not of the junction): found as a roundabout, its island
 *   round, the way round its ring lanes', its carriageway theirs; cars go through it, few collisions;
 * - an oval roundabout (three closed ring lanes of a road): found, not round (route fields take cars round it); cars go through;
 * - plain junctions (Video Demo, no island): each a zone; cars go through them and on along the lanes between them;
 * - route fields: reach every way in of every zone; round an island they only ever lead the ring's way;
 * - a car picked: what it is doing and the path it wants to take.
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
  let picked: ReturnType<SpatialSim["inspect"]> = null;
  for (let t = 0; t < T; t += 0.1) {
    sim.step(0.1);
    if (!picked?.path.length) { const v = sim.vehicles.find(w => w.mode === "spatial" && w.pathPts); if (v) picked = sim.inspect(v.id); }
  }
  return { sim, stats: sim.stats(), picked };
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
  const { stats, picked } = run(sk, 240);
  check(stats.finished >= 15, `Roundabout 3: cars through in 4 min (${stats.finished})`);
  check(stats.collisions <= 5, `Roundabout 3: few collisions (${stats.collisions})`);
  check(!!picked && picked.path.length > 5 && !!picked.goal && picked.doing.includes("Roundabout 3"), `a car picked: its path ahead and its way out (${picked?.doing})`);
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
  const { stats } = run(sk, 240);
  check(stats.finished >= 15, `Video Demo: cars through its junctions in 4 min (${stats.finished})`);
  check(stats.collisions <= 8, `Video Demo: few collisions (${stats.collisions})`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
