/**
 * Roundabouts at capacity (T172): a one-lane ring (S) and two two-lane ones (rings of 12 m and 16 m in one road, the inside lane
 * in joining the inner ring across the outer one; A: both lanes out leaving the outer ring, as J696's cut; B: the inside lane out
 * leaving the inner ring, across the outer one), 4 arms, every way in queued (600
 * vehicles/h a lane). Per way on: cars onto the ring an hour, the flow circulating past where it joins, the time between queued
 * cars going on (follow-up), and HCM 7's capacity for that lane at that flow (c = A·e^(−B·v_c)). Then: how many go onto the inner
 * ring, missed exits (going more than half a lap past the way off), collisions and deadlocks. As things are, and with each setting
 * given (key=value, as `sketch.traffic.tune`). RING_DEBUG=1 lists every way on; RING_GEOM=1 only prints the ways on and off's lengths
 * and speeds (RING_NEAR, RING_D try other arms).   npm run ring:check [-- key=value …]
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import type { Sketch, SketchConnector, SketchLane } from "../src/lib/lane-sketch";

type Variant = "S" | "A" | "B";
const TAU = 2 * Math.PI, r2 = (v: number) => Math.round(v * 100) / 100;

/** the test roundabout: 4 arms (at 0.4 rad and every quarter turn), 50 m of each, ending 40 m from the middle; the ways on joining
 * the ring 0.55 rad after the arm (the ways off leaving as far before it), driven at 4.5–5 m/s (J696's at 4–11), none crossing; ways
 * in give way */
export function testRoundabout(variant: Variant, rate: number, NEAR = Number(process.env.RING_NEAR ?? 40), D = Number(process.env.RING_D ?? 0.55)): Sketch {
  const C = { x: 0, y: 0 }, FAR = 90;
  const rings = variant === "S" ? [{ id: "O", r: 14, width: 5 }] : [{ id: "I", r: 12, width: 4 }, { id: "O", r: 16, width: 4 }];
  const ringR = new Map(rings.map(g => [g.id, g.r]));
  const ringS = (id: string, a: number) => r2(((((0 - a) % TAU) + TAU) % TAU) * ringR.get(id)!);
  const lanes: SketchLane[] = rings.map(g => ({ id: g.id, width: g.width, inRate: 0, shape: { kind: "arc", c: C, r: g.r, a0: 0, sweep: -TAU } as SketchLane["shape"] }));
  const connectors: SketchConnector[] = [], roads = variant !== "S" ? [{ id: "ring", name: "Ring", lanes: ["I", "O"] }] : [];
  for (let k = 0; k < 4; k++) {
    const th = (k * TAU) / 4 + 0.4, u = { x: Math.cos(th), y: Math.sin(th) }, t = { x: Math.sin(th), y: -Math.cos(th) };
    const at = (r: number, off: number) => ({ x: r2(u.x * r + t.x * off), y: r2(u.y * r + t.y * off) });
    const line = (id: string, a: { x: number; y: number }, b: { x: number; y: number }, inRate: number): SketchLane => ({ id, width: 3.5, inRate, ...(inRate ? { control: "yield" as const } : {}), shape: { kind: "line", pts: [a, b] } });
    // (ways in on the side the ring goes on to, ways out on the side it comes from; the near lanes by the road's middle)
    const inFar = line(`in-f-${k}`, at(FAR, 5.5), at(NEAR, 5.5), rate), outFar = line(`out-f-${k}`, at(NEAR, -5.5), at(FAR, -5.5), 0);
    lanes.push(inFar, outFar);
    connectors.push({ id: `c-in-f-${k}`, from: { lane: inFar.id, s: FAR - NEAR }, to: { lane: "O", s: ringS("O", th - D) } });
    connectors.push({ id: `c-out-f-${k}`, from: { lane: "O", s: ringS("O", th + D) }, to: { lane: outFar.id, s: 0 } });
    if (variant !== "S") {
      const inNear = line(`in-n-${k}`, at(FAR, 2), at(NEAR, 2), rate), outNear = line(`out-n-${k}`, at(NEAR, -2), at(FAR, -2), 0);
      lanes.push(inNear, outNear);
      roads.push({ id: `arm-${k}`, name: `Arm ${k}`, lanes: [inNear.id, inFar.id, outNear.id, outFar.id] });
      connectors.push({ id: `c-in-n-${k}`, from: { lane: inNear.id, s: FAR - NEAR }, to: { lane: "I", s: ringS("I", th - D) } });
      connectors.push(variant === "B" ? { id: `c-out-n-${k}`, from: { lane: "I", s: ringS("I", th + D) }, to: { lane: outNear.id, s: 0 } } : { id: `c-out-n-${k}`, from: { lane: "O", s: ringS("O", th + D + 0.05) }, to: { lane: outNear.id, s: 0 } });
    }
  }
  return { lanes, connectors, roads, junctions: [], traffic: { rate: 0, speed: 50, seed: 1 } };
}

/** HCM 7's capacity of an entry lane (vehicles/h) at a circulating flow `vc` (vehicles/h): a one-lane entry; a two-lane entry's right and left lanes facing two circulating lanes */
const hcm = (vc: number, lane: "one" | "right" | "left") => (lane === "one" ? 1380 * Math.exp(-1.02e-3 * vc) : lane === "right" ? 1420 * Math.exp(-0.85e-3 * vc) : 1350 * Math.exp(-0.92e-3 * vc));

interface Entry { id: string; ring: string; lane: "one" | "right" | "left"; perHour: number; circulating: number; hcm: number; followUp: number | null }
interface Result { entries: Entry[]; total: number; hcmTotal: number; inner: number; missed: number; onRing: number; collisions: number; deadlocks: number; out: number }

function run(variant: Variant, seed: number, tune: Record<string, number>, T = 900, WARM = 180): Result {
  const sk = testRoundabout(variant, 600);
  const sim = new SketchSim({ ...sk, traffic: { ...sk.traffic!, seed, ...(Object.keys(tune).length ? { tune } : {}) } }, { ...sk.traffic!, seed, ...(Object.keys(tune).length ? { tune } : {}) }) as unknown as {
    step: (dt: number) => void; t: number; finished: number; collisions: number; deadlocks: number;
    vehicles: { id: number; v: number; pos: number; edge: E }[]; edges: Map<string, E>;
  };
  type E = { key: string; id: string; kind: string; len: number; ring: boolean; from?: { lane: E; s: number }; to?: { lane: E; s: number }; locate: (s: number) => { p: { x: number; y: number } } };
  const rings = (variant === "S" ? ["O"] : ["I", "O"]).map(id => sim.edges.get(`lane:${id}`)!), radius = new Map(rings.map(e => [e, e.id === "I" ? 12 : variant === "S" ? 14 : 16]));
  const ways = [...sim.edges.values()].filter(e => e.kind === "conn" && e.to!.lane.ring && !e.from!.lane.ring);
  const onT = new Map(ways.map(e => [e, [] as number[]])), passed = new Map(ways.map(e => [e, 0]));
  const last = new Map<number, { edge: E; pos: number }>(), turned = new Map<number, { from: number; ang: number }>();
  let missed = 0, onRing = 0, inner = 0;
  const angle = (e: E, s: number) => { const p = e.locate(((s % e.len) + e.len) % e.len).p; return Math.atan2(p.y, p.x); };
  // (where on ring `L` a way on joins (its ring's place, at the same angle round the middle))
  const joinS = (e: E, L: E) => ((((-angle(e.to!.lane, e.to!.s)) % TAU) + TAU) % TAU) * radius.get(L)!;
  while (sim.t < T - 1e-9) {
    sim.step(0.1);
    for (const v of sim.vehicles) {
      const p = last.get(v.id);
      if (p) {
        // (onto the ring: when and where; round it: how far, in turns)
        if (p.edge !== v.edge && v.edge.ring && !p.edge.ring) { turned.set(v.id, { from: angle(v.edge, v.pos), ang: 0 }); if (sim.t > WARM) { onT.get(p.edge)?.push(sim.t); onRing++; if (v.edge.id === "I") inner++; } }
        else if (v.edge.ring) { const g = turned.get(v.id); if (g) g.ang += (v.v * 0.1) / radius.get(v.edge)!; }
        // (off it: further round than from where it came on to where it left, by more than half a lap: it missed its way off)
        if (p.edge.ring && !v.edge.ring) { const g = turned.get(v.id); if (g) { const need = ((((g.from - angle(p.edge, p.pos)) % TAU) + TAU) % TAU); if (sim.t > WARM && g.ang > need + Math.PI) missed++; turned.delete(v.id); } }
        // (passing where each way on joins, on either ring: the flow in front of it)
        if (p.edge === v.edge && v.edge.ring && sim.t > WARM) for (const e of ways) { const L = v.edge.len, s = joinS(e, v.edge), a = (((s - p.pos) % L) + L) % L, moved = (((v.pos - p.pos) % L) + L) % L; if (moved > 0 && moved < 10 && a > 0 && a <= moved) passed.set(e, passed.get(e)! + 1); }
      }
      last.set(v.id, { edge: v.edge, pos: v.pos });
    }
  }
  const H = (T - WARM) / 3600;
  const entries = ways.map(e => {
    const ts = onT.get(e)!, hw = ts.slice(1).map((t, i) => t - ts[i]).filter(h => h < 6).sort((a, b) => a - b);
    const lane = variant === "S" ? "one" as const : e.to!.lane.id === "O" ? "right" as const : "left" as const;
    // (the HCM counts every circulating lane in front of a two-lane entry)
    const vc = passed.get(e)! / H;
    return { id: e.id, ring: e.to!.lane.id, lane, perHour: ts.length / H, circulating: vc, hcm: hcm(vc, lane), followUp: hw.length ? hw[hw.length >> 1] : null };
  });
  return { entries, total: entries.reduce((a, x) => a + x.perHour, 0), hcmTotal: entries.reduce((a, x) => a + x.hcm, 0), inner: inner / H, missed, onRing, collisions: sim.collisions, deadlocks: sim.deadlocks, out: sim.finished };
}

if (process.env.RING_GEOM) {
  for (const variant of ["S", "A", "B"] as const) {
    const sim = new SketchSim(testRoundabout(variant, 0)) as unknown as { edges: Map<string, { kind: string; id: string; vmax: number; len: number; to?: { lane: { ring: boolean } }; from?: { lane: { ring: boolean } } }> };
    console.log(variant, [...sim.edges.values()].filter(e => e.kind === "conn").slice(0, 4).map(e => `${e.id} ${e.len.toFixed(1)} m ${e.vmax.toFixed(1)} m/s`).join(" | "), "| ring", [...sim.edges.values()].filter(e => e.kind === "lane" && (e.id === "O" || e.id === "I")).map(e => `${e.id} ${e.vmax.toFixed(1)}`).join(" "));
  }
  process.exit(0);
}
const tunes: Record<string, number>[] = [{}];
const asked = Object.fromEntries(process.argv.slice(2).filter(a => a.includes("=")).map(a => { const [k, v] = a.split("="); return [k, Number(v)]; }));
if (Object.keys(asked).length) tunes.push(asked);
const SEEDS = [1, 2];
const med = (xs: number[]) => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
for (const variant of ["S", "A", "B"] as const) for (const tune of tunes) {
  const rs = SEEDS.map(s => run(variant, s, tune));
  const name = `${variant === "S" ? "one-lane ring" : variant === "A" ? "two-lane ring, ways off the outer ring only (as J696)" : "two-lane ring, the inner ring with its own ways off"}, ${Object.keys(tune).length ? Object.entries(tune).map(([k, v]) => `${k}=${v}`).join(" ") : "as things are"}`;
  const n = rs.length, avg = (f: (r: Result) => number) => rs.reduce((a, r) => a + f(r), 0) / n;
  console.log(`\n${name} (seeds ${SEEDS.join(", ")}, 600 vehicles/h a lane in)`);
  for (const lane of ["one", "right", "left"] as const) {
    const es = rs.flatMap(r => r.entries.filter(e => e.lane === lane));
    if (!es.length) continue;
    const q = es.reduce((a, e) => a + e.perHour, 0) / n, c = es.reduce((a, e) => a + e.hcm, 0) / n;
    console.log(`  ${lane === "one" ? "the 4 ways on" : lane === "right" ? "the 4 outer-lane ways on" : "the 4 inner-lane ways on"}, together: ${Math.round(q)} /h onto the ring against HCM ${Math.round(c)} /h at the flow circulating (${Math.round((100 * q) / c)}%); follow-up ${med(es.map(e => e.followUp ?? NaN)).toFixed(1)} s (median of the medians)`);
  }
  if (process.env.RING_DEBUG) for (const e of rs[0].entries) console.log("   ", e.id, e.ring, Math.round(e.perHour), "vc", Math.round(e.circulating), "hcm", Math.round(e.hcm));
  console.log(`  all: ${Math.round(avg(r => r.total))} /h onto the ring (HCM ${Math.round(avg(r => r.hcmTotal))} /h); onto the inner ring ${Math.round(avg(r => r.inner))} /h; missed exits ${avg(r => r.missed).toFixed(1)} of ${Math.round(avg(r => r.onRing))} (${((100 * avg(r => r.missed)) / Math.max(1, avg(r => r.onRing))).toFixed(1)}%); out ${Math.round(avg(r => r.out))}; collisions ${avg(r => r.collisions)}; deadlocks ${avg(r => r.deadlocks)}`);
}
