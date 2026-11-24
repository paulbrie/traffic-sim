/**
 * tomtom-321:check (ticket #321): the pieces the inferred demand and the centre's turned streets rest on.
 *  - TomTom's recordings read as meant: a way's peak-hour share of free flow, the median of its weekdays' means; weekends,
 *    other hours, ways covered under half and ways seen on fewer than 3 weekdays left out;
 *  - the gravity matrix: each way in sends its P in all, shared by the ways out's A, never back out by its own road;
 *  - turning streets round on the plan (docs/experiments/tomtom-321/plan.json): each move's lanes run the other way, each
 *    with a way onto it at its new start and off it at its new end, connectors only from a lane's end to a lane's start
 *    where they were made, nothing dropped by the sketch's checks, a sign only where its street had one; refused (`reach`)
 *    when a trip would lose its way; and the simulation runs a turned design.
 * Exits 1 on any failure.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { demandWays, laneLength, pointAt, sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";
import { observed, type Peak } from "../src/lib/experiments/tomtom-321/observed";
import { endsOf, gravityMatrix } from "../src/lib/experiments/tomtom-321/demand";
import { deadLanes, laneEnds, lanesTurned, newEnds, movesOf, reach, streetsIn, turnLanes } from "../src/lib/experiments/tomtom-321/directions";
import { inCentre } from "../src/lib/experiments/tomtom-321/centre";
import { run, withMatrix } from "../src/lib/experiments/tomtom-321/sim";

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

// ---------------------------------------------------------------- TomTom's recordings
{
  const peak: Peak = { id: "morning", name: "m", from: "05:30", to: "06:30", start: 0, end: 0 };
  const day = (d: string, weekday: string, slot: string, ways: Record<string, [number, number, number, number, number]>) => ({ day: d, weekday, slot, ways });
  const e = {
    ways: [{ id: "w/a", name: "W", lengthM: 100 }, { id: "x/a", name: "X", lengthM: 50 }, { id: "y/a", name: "Y", lengthM: 80 }],
    samples: [
      // (w: three weekdays, two samples each, a weekend day and an hour outside the peak that must not count)
      day("d1", "Mon", "05:30", { "w/a": [20, 0.4, 50, 1, 0], "x/a": [20, 0.5, 40, 0.3, 0], "y/a": [10, 0.2, 50, 1, 0] }),
      day("d1", "Mon", "06:00", { "w/a": [30, 0.6, 50, 1, 0] }),
      day("d2", "Tue", "05:45", { "w/a": [35, 0.7, 50, 1, 0], "y/a": [10, 0.2, 50, 1, 0] }),
      day("d3", "Wed", "06:25", { "w/a": [45, 0.9, 50, 0.8, 0], "y/a": [10, 0.2, 50, 1, 0] }),
      day("d4", "Sat", "05:30", { "w/a": [5, 0.1, 50, 1, 0] }),
      day("d5", "Thu", "06:30", { "w/a": [5, 0.1, 50, 1, 0] }),
      day("d6", "Fri", "05:35", { "y/a": [0, 0, 50, 1, 1] }),
    ],
  };
  const o = observed(e, peak);
  check(Math.abs((o.get("w/a")?.rel ?? 0) - 0.7) < 1e-9 && o.get("w/a")?.days === 3, `a way's share: the median of its weekdays' means (0.5, 0.7, 0.9 → ${o.get("w/a")?.rel})`);
  check(!o.has("x/a"), "a way TomTom covers under half: left out");
  check(o.get("y/a")?.days === 3, "a closed way's sample left out (3 weekdays, not 4)");
  check(Math.abs((o.get("w/a")?.weight ?? 0) - 100 * (1 + 1 + 0.8) / 3) < 1e-6, "its weight: length × mean cover");
}

// ---------------------------------------------------------------- the plan
const plan = JSON.parse(readFileSync(join(__dirname, "../docs/experiments/tomtom-321/plan.json"), "utf8"));
const sk: Sketch = sanitizeSketch(plan.sketch)!;
const { ins, outs } = endsOf(sk);

// ---------------------------------------------------------------- the gravity matrix
{
  const P = Object.fromEntries(ins.map((i, k) => [i.key, 1000 + k])), A = Object.fromEntries(outs.map((o, k) => [o.key, 1 + (k % 3)]));
  const m = gravityMatrix(sk, { P, A }, "t", "t", { start: 420, end: 570 });
  const rowSum = (k: string) => Object.values(m.od[k] ?? {}).reduce((a, b) => a + b, 0);
  check(ins.every(i => Math.abs(rowSum(i.key) - P[i.key]) < 0.1 * Object.keys(m.od[i.key] ?? {}).length + 0.5), "each way in sends its P in all (to rounding)");
  check(ins.every(i => outs.every(o => !(o.road && o.road === i.road) || !m.od[i.key]?.[o.key])), "never back out by the road it came in on");
  const i0 = ins[0], row = m.od[i0.key], [a, b] = Object.keys(row);
  check(Math.abs(row[a] / row[b] - A[a] / A[b]) < 0.05, "a row shared by the ways out's A");
  check(m.start === 420 && m.end === 570, "the matrix keeps its period");
}

// ---------------------------------------------------------------- turning streets round
{
  const streets = streetsIn(sk, inCentre);
  check(streets.length >= 20, `the centre's streets that may be turned (${streets.length})`);
  const w = demandWays(sk), entries = w.entries.flatMap(e => e.lanes), exits = w.exits.flatMap(e => e.lanes), before = reach(sk, entries, exits);
  let moves = 0, refused = 0;
  const bad: string[] = [];
  for (const s of streets) for (const m of movesOf(s)) {
    moves++;
    const turned = lanesTurned(sk, s, m), after = turnLanes(sk, turned), T = new Set(turned);
    const what = `${s.name} ${m.to}`;
    const r = reach(after, entries, exits);
    let lost = 0;
    for (const [e, set] of before) for (const x of set) if (!r.get(e)!.has(x)) lost++;
    // (refused: a trip cut off, or a turned lane nobody could drive; the rest must be sound)
    if (lost || deadLanes(after, turned).length || newEnds(sk, after).length) { refused++; continue; }
    if (after.connectors.length !== sanitizeSketch(after)!.connectors.length) bad.push(`${what}: connectors dropped by the sketch's checks`);
    const len = new Map(after.lanes.map(l => [l.id, laneLength(l.shape)]));
    for (const id of turned) {
      const was = sk.lanes.find(l => l.id === id)!, now = after.lanes.find(l => l.id === id)!;
      const a0 = pointAt(was.shape, 0).p, b1 = pointAt(now.shape, len.get(id)!).p;
      if (Math.hypot(a0.x - b1.x, a0.y - b1.y) > 0.01) bad.push(`${what}: ${id} doesn't run the other way`);
      if (!after.connectors.some(c => c.to.lane === id && c.to.s < 0.5)) bad.push(`${what}: nothing onto ${id} at its new start`);
      if (!after.connectors.some(c => c.from.lane === id && c.from.s > len.get(id)! - 0.5)) bad.push(`${what}: nothing off ${id} at its new end`);
      const ends = laneEnds(sk).get(id)!, sign = now.control;
      if (sign && !sk.lanes.some(l => l.control === sign && !T.has(l.id) && laneEnds(sk).get(l.id)!.end === ends.start)) bad.push(`${what}: ${id} has a sign its street didn't have there`);
    }
    for (const c of after.connectors) if ((T.has(c.from.lane) && c.from.s < len.get(c.from.lane)! - 0.5) || (T.has(c.to.lane) && c.to.s > 0.5)) bad.push(`${what}: connector ${c.id} not end to start`);
  }
  check(bad.length === 0, `every move accepted (no trip cut off, no lane anywhere left dangling): its turned lanes run the other way with turns at both ends, end to start, signs only where their street had them (${moves} moves)${bad.length ? `: ${bad.slice(0, 5).join("; ")}` : ""}`);
  {
    // (ticket #321's first patch: Ecaterina Teodoroiu made one-way left the next piece north running out of a junction nothing led into)
    // (its lane l388 alone turned: the street's next pieces, joined in no junction drawn, weren't taken as part of it then)
    const after = turnLanes(sk, ["l388"]);
    check(newEnds(sk, after).length > 0, `a change leaving a neighbouring lane with nothing onto or off it is found (${newEnds(sk, after).join(", ")})`);
    const e = streets.find(x => x.name === "Strada Ecaterina Teodoroiu" && x.kind === "1+1");
    check(!!e && ["r218", "r219", "r220", "r221"].every(r => e.roads.includes(r)), `a street's pieces joined in no junction drawn are one street (Ecaterina Teodoroiu: ${e?.roads.join(", ")})`);
  }
  check(refused > 0 && refused < moves, `moves that would cut a trip off or leave a lane nobody could drive are refused (${refused} of ${moves})`);

  // (a design of several turned streets, run: cars come in, finish trips and drive the turned streets)
  const ok = streets.flatMap(s => movesOf(s).map(m => ({ s, m }))).filter(({ s, m }) => {
    const t = lanesTurned(sk, s, m), after = turnLanes(sk, t), r = reach(after, entries, exits);
    if (deadLanes(after, t).length || newEnds(sk, after).length || /^Bulevardul/.test(s.name)) return false;
    for (const [e, set] of before) for (const x of set) if (!r.get(e)!.has(x)) return false;
    return true;
  });
  const pick = ok.filter((x, i) => ok.findIndex(y => y.s.id === x.s.id) === i).slice(0, 4);
  const turned = pick.flatMap(({ s, m }) => lanesTurned(sk, s, m));
  const design = turnLanes(sk, turned);
  const P = Object.fromEntries(ins.map(i => [i.key, 40])), A = Object.fromEntries(outs.map(o => [o.key, 1]));
  const res = run(withMatrix(design, gravityMatrix(design, { P, A }, "t", "t"), 2), { seed: 1, warmupMin: 2, measureMin: 4 });
  check(res.trips > 1000, `a design with ${pick.map(x => `${x.s.name} ${x.m.to}`).join(", ")} turned runs (${Math.round(res.trips)} trips an hour)`);
  const driven = turned.filter(id => [...res.ways.values()].some(w => w.km > 0 && sk.roads.some(r => r.lanes.includes(id) && w.id.startsWith(`${r.id}/`))));
  check(driven.length > 0, `cars drive the turned lanes (${driven.length} of ${turned.length} with traffic)`);
}

if (fails) { console.error(`tomtom-321:check: ${fails} failed`); process.exit(1); }
console.log("tomtom-321:check: all passed");
