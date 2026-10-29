/**
 * Laps round a two-lane roundabout for nothing (ticket #104): cars that missed their way off by planning a lane change across the
 * ring they had no room for, and went round again. Two small roundabouts (rings of 7 and 10.6 m round one middle, in one road):
 * - 1, routes: a way on to the outer ring joining 2 m (as beside on the inner) short of the inner ring's way off to out1; the inner
 *   ring's own way on joining just where that way off leaves (as Bistrița's c5226 / c5235), its next way off 7 m on to out2, beside
 *   out1. The route by the outer ring must count the lap it needs (a change takes room), so cars for out1 take the inner ring, then
 *   out2 and change over; none goes more than a full lap round;
 * - 2, lane by exit: one lane onto both rings; the first arm's way off to the destination only leaves the inner ring, its other way
 *   off (to another road) the outer one. Cars go onto the inner ring for it, none round again.
 *   npm run ring-lap:check
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import { RouteTable, type Sketch, type SketchConnector, type SketchLane } from "../src/lib/lane-sketch";

let bad = 0;
function check(name: string, ok: boolean, info = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? `: ${info}` : ""}`);
  if (!ok) bad++;
}
const RI = 7, RO = 10.6, r2 = (v: number) => Math.round(v * 100) / 100;
const ring = (id: string, r: number): SketchLane => ({ id, width: 3.5, inRate: 0, shape: { kind: "arc", c: { x: 0, y: 0 }, r, a0: 0, sweep: -2 * Math.PI } });
/** a straight lane along the ray at angle `th`, from radius r0 to r1, `off` metres beside it */
const ray = (id: string, th: number, r0: number, r1: number, off: number, inRate = 0): SketchLane => {
  const t = { x: Math.sin(th), y: -Math.cos(th) }, p = (r: number) => ({ x: r2(r * Math.cos(th) + t.x * off), y: r2(r * Math.sin(th) + t.y * off) });
  return { id, width: 3.5, inRate, ...(inRate ? { control: "yield" as const } : {}), shape: { kind: "line", pts: [p(r0), p(r1)] } };
};
const conn = (id: string, from: string, fs: number, to: string, ts: number): SketchConnector => ({ id, from: { lane: from, s: fs }, to: { lane: to, s: ts } });

/** 1: the ways in at angle 0 (outer lane ax onto O, inner ay onto I), the ways out further round (out1 from I where ay joins, out2 7 m on) */
function fixture1(): Sketch {
  const sO = r2(0.55 * RO), sI = r2(0.55 * RI + 2), th = -(sI / RI) - 0.7;
  return {
    lanes: [ring("I", RI), ring("O", RO), ray("ax", 0, 70, 20, 5.5, 500), ray("ay", 0, 70, 20, 2, 500), ray("out1", th, 20, 100, -2), ray("out2", th, 20, 100, -5.5)],
    connectors: [conn("cx", "ax", 50, "O", sO), conn("cy", "ay", 50, "I", sI), conn("e1", "I", sI, "out1", 0), conn("e2", "I", r2(sI + 7), "out2", 0)],
    roads: [{ id: "ring", name: "Ring", lanes: ["I", "O"] }, { id: "in", name: "In", lanes: ["ax", "ay"] }, { id: "out", name: "Out", lanes: ["out1", "out2"] }],
    junctions: [], traffic: { rate: 0, speed: 50, seed: 1, tune: { ringLanes: 1, ringDriving: 1 } },
  };
}
/** 2: one way in onto both rings; the first arm out (a quarter round): `to` (the destination) off the inner ring, `side` off the outer */
function fixture2(): Sketch {
  const sO = r2(0.55 * RO), sI = r2(0.55 * RI), th = -Math.PI / 2;
  const out: SketchLane = { ...ray("to", th - 0.55, 20, 100, -2), outWeight: 1 }, side: SketchLane = { ...ray("side", th - 0.55, 20, 100, -5.5), outWeight: 0 };
  return {
    lanes: [ring("I", RI), ring("O", RO), ray("a", 0, 70, 20, 4, 600), out, side],
    connectors: [conn("cx", "a", 50, "O", sO), conn("cy", "a", 50, "I", sI), conn("ei", "I", r2(-(th - 0.15) * RI), "to", 0), conn("eo", "O", r2(-(th - 0.15) * RO), "side", 0)],
    roads: [{ id: "ring", name: "Ring", lanes: ["I", "O"] }, { id: "out", name: "Out", lanes: ["to"] }, { id: "side", name: "Side road", lanes: ["side"] }],
    junctions: [], traffic: { rate: 0, speed: 50, seed: 1, tune: { ringLanes: 1, ringDriving: 1 } },
  };
}

/**
 * 3: one way on, to the outer ring; the inner ring's way off to `to` just past where a change 20 m on would come beside it (no room
 * to change in time, the inner ring busy with cars from b), the outer ring's next way off to `side`, beside `to` in one road: by the
 * outer ring and over, not round again
 */
function fixture3(): Sketch {
  const sO = r2(0.55 * RO), thI = -0.55 - 20 / RO - 1.3 / RI, thO = thI - 0.3;
  return {
    lanes: [ring("I", RI), ring("O", RO), ray("a", 0, 70, 20, 5.5, 600), { ...ray("to", thO - 0.55, 20, 100, -2), outWeight: 1 }, { ...ray("side", thO - 0.55, 20, 100, -5.5), outWeight: 0 },
      // (the inner ring kept busy past where the change would be: cars from b, round to bo)
      ray("b", 1.2, 70, 20, 2, 900), { ...ray("bo", -Math.PI - 0.55, 20, 100, -2), outWeight: 1 }],
    connectors: [conn("cx", "a", 50, "O", sO), conn("ei", "I", r2(-thI * RI), "to", 0), conn("eo", "O", r2(-thO * RO), "side", 0),
      conn("cb", "b", 50, "I", r2(2 * Math.PI * RI - 0.65 * RI)), conn("eb", "I", r2(Math.PI * RI), "bo", 0)],
    roads: [{ id: "ring", name: "Ring", lanes: ["I", "O"] }, { id: "out", name: "Out", lanes: ["to", "side"] }, { id: "bo", name: "B out", lanes: ["bo"] }],
    junctions: [], traffic: { rate: 0, speed: 50, seed: 1, tune: { ringLanes: 1, ringDriving: 1 } },
  };
}

/** a run of `T` s: rides round the ring, those over a full lap, the ways on the cars took, collisions */
function laps(sk: Sketch, T = 600) {
  const sim = new SketchSim(sk, sk.traffic!, 1) as unknown as { t: number; step(dt: number): void; stats(): { collisions: number; finished: number }; vehicles: { id: number; v: number; pos: number; edge: { key: string; ring: boolean; len: number } }[] };
  const on = new Map<number, { deg: number; key: string; pos: number }>(), took = new Map<string, number>();
  let rides = 0, over = 0;
  while (sim.t < T - 1e-6) {
    const was = new Map(sim.vehicles.map(v => [v.id, v.edge.key]));
    sim.step(0.1);
    for (const v of sim.vehicles) {
      const r = v.edge.key === "lane:I" ? RI : RO;
      if (v.edge.ring) {
        const o = on.get(v.id);
        if (!o) { on.set(v.id, { deg: 0, key: v.edge.key, pos: v.pos }); const k = was.get(v.id) ?? ""; took.set(k, (took.get(k) ?? 0) + 1); continue; }
        o.deg += ((v.edge.key === o.key ? (((v.pos - o.pos) % v.edge.len) + v.edge.len) % v.edge.len : v.v * 0.1) / r) * (180 / Math.PI);
        o.key = v.edge.key; o.pos = v.pos;
      } else if (on.has(v.id)) { rides++; if (on.get(v.id)!.deg > 360) over++; on.delete(v.id); }
    }
  }
  return { rides, over, took, ...sim.stats() };
}

{
  const sk = fixture1(), rt = new RouteTable(sk);
  const viaO = rt.viaConnector("cx", "out1"), viaI = rt.viaConnector("cy", "out1");
  check("1: the outer ring's way on to out1 counts a lap (no room to change in 2 m)", viaO > viaI && viaO > 2 * Math.PI * RI, `by cx ${viaO.toFixed(1)} m, by cy ${viaI.toFixed(1)} m`);
  const r = laps(sk);
  check("1: cars ride round, none more than a lap", r.rides > 50 && r.over === 0, `${r.rides} rides, ${r.over} over a lap, ways on ${JSON.stringify(Object.fromEntries(r.took))}`);
  check("1: no collisions", r.collisions === 0, String(r.collisions));
}
{
  const r = laps(fixture2());
  check("2: cars for the inner ring's way off go onto the inner ring", (r.took.get("conn:cy") ?? 0) > 0.9 * r.rides, JSON.stringify(Object.fromEntries(r.took)));
  check("2: none more than a lap", r.rides > 50 && r.over === 0, `${r.rides} rides, ${r.over} over a lap`);
  check("2: no collisions", r.collisions === 0, String(r.collisions));
}

{
  const r = laps(fixture3());
  // (not its collisions: b's way on, drawn roughly across the outer ring, has one now and then, with or without this)
  check("3: no room to change for the inner ring's way off: none more than a lap", r.rides > 50 && r.over === 0, `${r.rides} rides, ${r.over} over a lap`);
}

if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
