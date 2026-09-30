import { Sim, sampleTown, compile, connectorPreview, measureRun, optimizeSignals } from "../src/engine";
import { makeLink, makeNode } from "../src/engine/sample";
import * as mirrorModule from "../src/engine/sim/mirror";
import { readFileSync } from "fs";
import { sanitizeNetwork } from "../src/engine/validate";
import { polyCentroid } from "../src/engine/buildings";
import type { Network } from "../src/engine/types";
import { customizePhases, addPhase, approachesTo, setLaneGreen, reverseLink, splitLink, linkPoint, nodeById, addSlipLane, mergeLinks, smoothBetween } from "../src/state/ops";
import { buildRoadGeo } from "../src/render/geometry";
import { routeBetween, routeShape } from "../src/engine/route";
const net = sampleTown();
const c = compile(net);
console.log("edges", c.edges.length, "nodes", c.nodes.length, "warnings", c.warnings);
for (const n of c.nodes) if (n.degree >= 3) console.log(n.def.control, "deg", n.degree, "phases", JSON.stringify(n.phases), "ring", n.ringR.toFixed(1), "moves", [...n.moves.values()].map(l => l.map(m => `${m.turn}[${m.lo}-${m.hi}]`).join(",")).join(" | "));
for (const [cars, trucks] of [[40, 4], [80, 8], [140, 14], [200, 20]]) {
  const sim = new Sim(net, { cars, trucks, seed: 7 });
  const t0 = Date.now();
  const st: Record<string, number> = {};
  sim.run(6000);
  let bad = 0;
  for (const v of sim.vehicles) if (!v.dead) { st[v.state] = (st[v.state] || 0) + 1; const p = sim.pose(v); if (!isFinite(p.fx) || !isFinite(v.s)) bad++; }
  const S = sim.stats;
  console.log(cars, trucks, "n", S.count, "bus", S.buses, "v", S.avgSpeed.toFixed(1), "stop%", (S.stopped * 100).toFixed(0), "tpm", S.tripsPerMin, "towed", S.towed, "lc", S.laneChanges, "boarded", S.boarded, "bad", bad, "ms", Date.now() - t0, JSON.stringify(st));
}

// custom (per-lane) traffic light phases: a protected left turn for the boulevard's leftmost lane
{
  let n2 = sampleTown();
  const c0 = compile(n2);
  const j = c0.nodes.find(n => n.def.control === "lights" && n.degree === 4 && n.arms.some(a => (a.inEdge?.n ?? 0) >= 3))!;
  n2 = addPhase(customizePhases(n2, c0, j.def.id), j.def.id);
  const wide = approachesTo(n2, j.def.id).find(a => a.lanes >= 3)!;
  for (const p of (wide.dir === 1 ? wide.link.greenF : wide.link.greenB)![0]) n2 = setLaneGreen(n2, wide.link.id, wide.dir, 0, p, false);
  n2 = setLaneGreen(n2, wide.link.id, wide.dir, 0, 2, true);
  const lanesOf = (net: typeof n2) => { const c = compile(net), n = c.nodeById.get(j.def.id)!; return JSON.stringify(n.arms.map(a => (a.inEdge ? `${a.inEdge.link.name}:${JSON.stringify(n.lanePhases[n.arms.indexOf(a)])}` : "")).sort()); };
  const before = lanesOf(n2);
  // editing the roads keeps each lane's phases
  const reversed = reverseLink(n2, wide.link.id);
  const A = nodeById(n2, wide.link.from)!, B = nodeById(n2, wide.link.to)!;
  const [split] = splitLink(n2, wide.link.id, 0.5, linkPoint(wide.link, A, B, 0.5));
  console.log("custom phases survive reverse / split:", lanesOf(reversed) === before, lanesOf(split) === before);
  const c = compile(n2), cj = c.nodeById.get(j.def.id)!, arm = cj.arms.findIndex(a => a.inEdge?.link.id === wide.link.id && a.inEdge.dir === wide.dir);
  const sim = new Sim(c, { cars: 140, trucks: 14, seed: 7 });
  let wrong = 0, leftGreen = 0;
  for (let t = 0; t < 4000; t++) {
    sim.step();
    const st = sim.nodeState(cj.idx), s0 = sim.signalFor(cj.idx, arm, 0), s1 = sim.signalFor(cj.idx, arm, 1);
    if (s0 === "green") { leftGreen++; if (st.phase !== 2) wrong++; }
    if (s1 === "green" && st.phase === 2 && st.stage === 0) wrong++;
  }
  const S = sim.stats;
  console.log("protected left: green", leftGreen, "ticks, wrong aspects", wrong, "| n", S.count, "v", S.avgSpeed.toFixed(1), "towed", S.towed, "warnings", c.warnings.length);
  if (wrong) process.exit(1);
}

// general traffic never drives in a bus lane
{
  const sim = new Sim(net, { cars: 140, trucks: 14, seed: 7 });
  let onBus = 0;
  for (let t = 0; t < 4000; t++) {
    sim.step();
    for (const v of sim.vehicles) if (!v.dead && v.kind !== "bus" && v.piece.kind === "lane" && v.piece.edge.bus && v.piece.lane === v.piece.edge.n - 1) onBus++;
  }
  console.log("cars in bus lanes (vehicle-ticks):", onBus);
  if (onBus) process.exit(1);
}

// signal optimiser: a short search on the sample town runs end to end and reports a fresh-seed check
{
  const base = { cars: 140, trucks: 14, seed: 7 };
  const spec = { warmup: 30, measure: 60 };
  optimizeSignals(net, base, { nodes: compile(net).nodes.filter(n => n.controlled && n.degree >= 3).map(n => n.def.id), targets: ["greens", "control", "lefts", "lanes"], seeds: [1, 2], confirmSeeds: [51, 52], holdoutSeeds: [101, 102], spec, rounds: 1 },
    async (nets, seeds) => nets.map(n => seeds.map(seed => measureRun(n, { ...base, seed }, spec)))).then(r => {
    console.log("optimiser:", r.evaluations, "candidates;", r.changes.length, "changes; fresh-seed check better on", r.check.better, "of", r.check.of);
    if (!r.evaluations || r.check.of !== 2) process.exit(1);
  });
}

// the page's mirror of a simulation running in a worker answers exactly what the simulation would
{
  const { SnapshotWriter, SimMirror } = mirrorModule;
  const town = sampleTown();
  const sim = new Sim(compile(town), { cars: 140, trucks: 14, seed: 7 });
  sim.logAll = true;
  const writer = new SnapshotWriter(), mirror = new SimMirror(compile(JSON.parse(JSON.stringify(town))));
  let diffs = 0, checks = 0;
  for (let round = 0; round < 12; round++) {
    sim.run(250);
    const { snap } = writer.write(sim, { vehicle: sim.vehicles.find(v => !v.dead)?.id ?? null, nodes: sim.net.nodes.map(n => n.idx), reservations: true }, round * 1000);
    mirror.apply(structuredClone(snap));
    const live = sim.vehicles.filter(v => !v.dead);
    live.forEach((v, i) => {
      const a = sim.pose(v), b = mirror.pose(mirror.vehicles[i]);
      checks++; if (mirror.vehicles[i].id !== v.id || Math.hypot(a.fx - b.fx, a.fy - b.fy, a.rx - b.rx, a.ry - b.ry) > 1e-3 || sim.blinker(v) !== mirror.blinker(mirror.vehicles[i])) diffs++;
    });
    for (const n of sim.net.nodes) {
      n.arms.forEach((a, arm) => { for (let lane = -1; lane < (a.inEdge?.n ?? 0); lane++) { checks++; if (sim.signalFor(n.idx, arm, lane < 0 ? undefined : lane) !== mirror.signalFor(n.idx, arm, lane < 0 ? undefined : lane)) diffs++; } });
      const s1 = sim.nodeState(n.idx), s2 = mirror.nodeState(n.idx);
      checks++; if (s1.phase !== s2.phase || s1.stage !== s2.stage || s1.occupied !== s2.occupied || Math.abs(s1.t - s2.t) > 1e-3) diffs++;
    }
    checks++; if (JSON.stringify(sim.events) !== JSON.stringify(mirror.events)) diffs++;
    checks++; if (mirror.vehicles.length !== live.length) diffs++;
  }
  console.log("worker mirror:", checks, "checks,", diffs, "differences");
  if (diffs) process.exit(1);
}

// traffic counters only observe: switching them on everywhere changes nothing, and the mirror reports them
{
  const plain = sampleTown();
  const counted = { ...plain, links: plain.links.map(l => ({ ...l, counter: true })) };
  const a = new Sim(compile(plain), { cars: 140, trucks: 14, seed: 7 }), b = new Sim(compile(counted), { cars: 140, trucks: 14, seed: 7 });
  a.run(3000); b.run(3000);
  const same = a.stats.trips === b.stats.trips && a.stats.towed === b.stats.towed && a.vehicles.length === b.vehicles.length
    && a.vehicles.every((v, i) => v.id === b.vehicles[i].id && v.s === b.vehicles[i].s && v.piece.id === b.vehicles[i].piece.id);
  const readings = b.net.edges.map(e => b.counterStats(e.idx)!);
  const total = readings.reduce((s, r) => s + r.total, 0), mixOk = readings.every(r => r.cars + r.trucks + r.buses === r.total);
  const { SnapshotWriter, SimMirror } = mirrorModule;
  const m = new SimMirror(compile(counted));
  m.apply(structuredClone(new SnapshotWriter().write(b, { vehicle: null, nodes: [], reservations: false }, 0).snap));
  const mirrorOk = b.net.edges.every(e => JSON.stringify(m.counter(e.link.id, e.dir)) === JSON.stringify(b.counterStats(e.idx)));
  console.log("traffic counters: identical run", same, "| passes counted", total, "| by kind adds up", mixOk, "| mirror matches", mirrorOk);
  if (!same || !total || !mixOk || !mirrorOk) process.exit(1);
}

// transit flows: vehicles enter at one entry point at the set rate and leave at the other
{
  const town = sampleTown(), c0 = compile(town);
  const gates = c0.nodes.filter(n => n.gateway);
  // the two entry points farthest apart
  let a = gates[0], b = gates[1], far = 0;
  for (const g of gates) for (const h of gates) { const d = Math.hypot(g.pos.x - h.pos.x, g.pos.y - h.pos.y); if (d > far) { far = d; a = g; b = h; } }
  const net = { ...town, flows: [{ id: "f1", from: a.def.id, to: b.def.id, rate: 600, trucks: 0.1 }] };
  const sim = new Sim(compile(net), { cars: 140, trucks: 14, seed: 7 });
  let wrongDest = 0;
  for (let t = 0; t < 3000; t++) {
    sim.step();
    for (const v of sim.vehicles) if (!v.dead && v.flow === 0 && !(v.dest.kind === "gateway" && v.dest.node.def.id === b.def.id)) wrongDest++;
  }
  const f = sim.flowStats(0)!;
  const accounted = f.sent === f.arrived + f.diverted + f.towed + f.inPlan;
  const expected = (600 * 300) / 3600, came = f.sent + f.backlog;
  const { SnapshotWriter, SimMirror } = mirrorModule;
  const m = new SimMirror(compile(net));
  m.apply(structuredClone(new SnapshotWriter().write(sim, { vehicle: null, nodes: [], reservations: false }, 0).snap));
  const mirrorOk = JSON.stringify(m.flow("f1")) === JSON.stringify(f);
  console.log(`transit flow: ${came} arrivals for ~${expected} expected, sent ${f.sent}, arrived ${f.arrived} (avg ${f.avgTravel.toFixed(0)} s), diverted ${f.diverted}, towed ${f.towed}, driving ${f.inPlan}, queued ${f.backlog} | accounted ${accounted}, off course ${wrongDest}, mirror ${mirrorOk}`);
  if (!accounted || !mirrorOk || !f.arrived || Math.abs(came - expected) > 4 * Math.sqrt(expected)) process.exit(1);
}

// drawing every lane connector (a preview) doesn't touch the simulation
{
  const town = sampleTown();
  const c1 = compile(town), c2 = compile(town);
  const shown = connectorPreview(c2).length;
  const s1 = new Sim(c1, { cars: 140, trucks: 14, seed: 7 }), s2 = new Sim(c2, { cars: 140, trucks: 14, seed: 7 });
  s1.run(2000); s2.run(2000);
  const same = s1.stats.trips === s2.stats.trips && s1.vehicles.length === s2.vehicles.length && s1.vehicles.every((v, i) => v.s === s2.vehicles[i].s && v.piece.id === s2.vehicles[i].piece.id);
  console.log("lane connector preview:", shown, "connectors drawn; run unchanged", same);
  if (!same || !shown) process.exit(1);
}

// zones: demand between groups of entry points and buildings
{
  const cluj = JSON.parse(readFileSync("scripts/fixtures/osm-cluj.json", "utf8")) as Network;
  const c0 = compile(cluj), b = c0.bounds, w = b.maxX - b.minX;
  const side = (x: number) => (x < b.minX + w / 3 ? "W" : x > b.maxX - w / 3 ? "E" : "");
  const members = (s: string) => [
    ...c0.nodes.filter(n => n.gateway && side(n.pos.x) === s).map(n => ({ kind: "entry" as const, id: n.def.id })),
    ...(cluj.buildings ?? []).filter(bd => side(polyCentroid(bd.pts).x) === s).map(bd => ({ kind: "building" as const, id: bd.id })),
  ];
  const net: Network = { ...cluj, zones: [{ id: "zw", name: "West", color: "#2f6fb5", members: members("W") }, { id: "ze", name: "East", color: "#b5462f", members: members("E") }],
    zoneFlows: [{ id: "we", from: "zw", to: "ze", rate: 600 }, { id: "ew", from: "ze", to: "zw", rate: 300, trucks: 0.1 }] };
  const clean = sanitizeNetwork(net);
  const sim = new Sim(compile(clean), { cars: 150, trucks: 10, seed: 7 });
  const inZone = (zid: string, d: { kind: string; node?: { def: { id: string } }; edge?: unknown }) => {
    const z = sim.net.zones.find(x => x.def.id === zid)!;
    return d.kind === "gateway" ? z.entries.some(n => n.def.id === d.node!.def.id) : z.places.some(p => p.opts.some(o => o.edge === d.edge));
  };
  let offGoal = 0;
  for (let t = 0; t < 3000; t++) {
    sim.step();
    for (const v of sim.vehicles) if (!v.dead && v.zflow >= 0 && !inZone(sim.net.zoneFlows[v.zflow].def.to, v.goal as never)) offGoal++;
  }
  const r = sim.net.zoneFlows.map(f => ({ f, s: sim.zoneFlowStats(f.idx)! }));
  const ok = r.every(({ f, s }) => s.sent === s.arrived + s.diverted + s.towed + s.inPlan && Math.abs(s.sent + s.backlog - (f.def.rate * 300) / 3600) <= 4 * Math.sqrt((f.def.rate * 300) / 3600) && s.arrived > 0);
  const m = new mirrorModule.SimMirror(compile(clean));
  m.apply(structuredClone(new mirrorModule.SnapshotWriter().write(sim, { vehicle: null, nodes: [], reservations: false }, 0).snap));
  const mirrorOk = r.every(({ f, s }) => JSON.stringify(m.zoneFlow(f.def.id)) === JSON.stringify(s));
  console.log("zones:", clean.zones!.map(z => `${z.name} ${z.members.length} members`).join(", "), "|", r.map(({ f, s }) => `${f.def.id}: sent ${s.sent}, arrived ${s.arrived} (${s.avgTravel.toFixed(0)} s), queued ${s.backlog}`).join("; "), "| ok", ok, "off goal", offGoal, "mirror", mirrorOk);
  if (!ok || offGoal || !mirrorOk) process.exit(1);
}

// turn bays and a median: a lit crossroads where the main road has a left and a right turn bay
{
  const J = makeNode(0, 0, "lights", false), E = makeNode(260, 0), W = makeNode(-260, 0), N = makeNode(0, -220), S = makeNode(0, 220);
  const bays = { left: 1, leftLen: 60, right: 1, rightLen: 40 };
  const net: Network = {
    version: 1, nodes: [J, E, W, N, S], stops: [], lines: [],
    links: [
      makeLink(E, J, 2, 2, { baysF: bays, median: 4, medianKind: "raised", speed: 60 }), makeLink(W, J, 2, 2, { baysF: bays, median: 4, medianKind: "raised", speed: 60 }),
      makeLink(N, J, 1, 1), makeLink(S, J, 1, 1),
    ],
  };
  const clean = sanitizeNetwork(net), cc = compile(clean);
  const main = cc.edges.filter(e => e.to === cc.nodeById.get(J.id) && e.n === 4);
  const shape = main.length === 2 && main.every(e => e.left === 1 && e.thru === 2 && e.right === 1 && e.open[0] > 100 && e.open[3] > 150 && e.open[1] === 0 && e.base === 2);
  const sim = new Sim(cc, { cars: 180, trucks: 10, seed: 3 });
  sim.logAll = true;
  let early = 0, badL = 0, badR = 0, lefts = 0, rights = 0;
  const seen = new Set<string>();
  for (let t = 0; t < 4000; t++) {
    sim.step();
    for (const v of sim.vehicles) {
      if (v.dead) continue;
      const p = v.piece;
      if (p.kind === "lane" && p.edge.open[p.lane] > 0 && v.s < p.edge.open[p.lane] - 0.5) early++;
      if (p.kind === "conn" && main.includes(p.inEdge) && !seen.has(`${v.id}`)) {
        seen.add(`${v.id}`);
        if (p.move.turn === "L") { lefts++; if (p.inLane !== 0) badL++; }
        if (p.move.turn === "R") { rights++; if (p.inLane !== 3) badR++; }
      }
    }
  }
  const st = sim.stats, gaveUp = sim.events.filter(ev => ev.kind === "turn-changed").length;
  const ok = gaveUp <= 15 && shape && early === 0 && badL === 0 && badR === 0 && lefts > 5 && rights > 5 && st.trips > 150 && st.towed <= 2;
  console.log(`turn bays: shape ${shape}; ${lefts} left turns (${badL} not from the bay), ${rights} right turns (${badR} not from the bay), ${early} in a bay before it opens; ${gaveUp} gave up their turn; ${st.trips} trips, ${st.towed} towed | ok ${ok}`);
  if (!ok) process.exit(1);
}

// slip lanes: free right turns round an island, off the junction
{
  const J = makeNode(0, 0, "lights", false), E = makeNode(300, 0), W = makeNode(-300, 0), N = makeNode(0, -260), S = makeNode(0, 260);
  const lE = makeLink(E, J, 2, 2, { median: 3 }), lW = makeLink(W, J, 2, 2, { median: 3 }), lN = makeLink(N, J, 1, 1), lS = makeLink(S, J, 1, 1);
  let net: Network = { version: 1, nodes: [J, E, W, N, S], stops: [], lines: [], links: [lE, lW, lN, lS] };
  // right turns: from the east road into the north road, from the west road into the south road
  for (const [a, b] of [[lE.id, lN.id], [lW.id, lS.id]]) {
    const [n2, err] = addSlipLane(net, J.id, a, b);
    if (err) { console.log("slip lanes:", err); process.exit(1); }
    net = n2;
  }
  const clean = sanitizeNetwork(net), cc = compile(clean), cj = cc.nodeById.get(J.id)!;
  const slips = clean.links.filter(l => l.slip === J.id);
  const slipEdges = new Set(cc.edges.filter(e => e.link.slip).map(e => e.idx));
  // the junction no longer offers those right turns (its right turns from the main road are gone)
  const rightsLeft = [...cj.moves.values()].flat().filter(m => m.turn === "R" && m.in.n === 2).length;
  const islands = buildRoadGeo(cc, clean).islands.length;
  const sim = new Sim(cc, { cars: 160, trucks: 8, seed: 5 });
  const used = new Set<number>();
  for (let t = 0; t < 3000; t++) {
    sim.step();
    for (const v of sim.vehicles) if (!v.dead && v.piece.kind === "lane" && slipEdges.has(v.piece.edge.idx)) used.add(v.id);
  }
  const st = sim.stats;
  const ok = slips.length === 2 && rightsLeft === 0 && islands === 2 && used.size > 10 && st.towed <= 1 && !cc.warnings.some(w => /short/.test(w));
  console.log(`slip lanes: ${slips.length} added, ${rightsLeft} right turns left at the junction from the main road, ${islands} islands; ${used.size} vehicles took them; ${st.trips} trips, ${st.towed} towed${cc.warnings.length ? " | warnings: " + cc.warnings.join(" ") : ""} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// route tracer: a test vehicle from one entry point to another arrives, and doesn't count as regular traffic
{
  const c = compile(sampleTown()), gates = c.nodes.filter(n => n.gateway);
  const [a, b] = [gates[0], gates[gates.length - 1]];
  const route = routeBetween(c, a.def.id, b.def.id), shape = route ? routeShape(route) : null;
  const sim = new Sim(c, { cars: 60, trucks: 4, seed: 7 });
  for (let t = 0; t < 300; t++) sim.step();
  const r = sim.sendTest(a.def.id, b.def.id);
  let t = 0;
  while (sim.tests[0]?.done === null && t++ < 6000) sim.step();
  const tr = sim.tests[0];
  const ok = !!shape && "id" in r && tr?.done === "arrived" && tr.time > shape.time * 0.8 && sim.vehicles.filter(v => !v.dead && v.test === undefined && !v.metered && v.kind === "car").length <= 60;
  console.log(`route tracer: ${shape ? `${(shape.length / 1000).toFixed(2)} km, ${shape.junctions} junctions, ${shape.time.toFixed(0)} s free-flow` : "no route"}; test vehicle ${tr ? `${tr.done} in ${tr.time.toFixed(0)} s` : JSON.stringify(r)} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// pedestrians: they cross at a lit junction and at a zebra on a plain road; no vehicle is ever let
// across a crossing while people are on it, and traffic is slower for them
{
  const run = (peds: number) => {
    const J = makeNode(0, 0, "lights", false), Z = { ...makeNode(-120, 0, "priority", false), junction: true, peds: peds || null };
    const E = makeNode(200, 0), W = makeNode(-260, 0), N = makeNode(0, -200), S = makeNode(0, 200);
    const net: Network = { version: 1, nodes: [{ ...J, peds: peds || null }, Z, E, W, N, S], stops: [], lines: [], links: [
      makeLink(E, J, 2, 2), makeLink(Z, J, 2, 2), makeLink(W, Z, 2, 2), makeLink(N, J, 1, 1), makeLink(S, J, 1, 1),
    ] };
    const sim = new Sim(compile(sanitizeNetwork(net)), { cars: 120, trucks: 6, seed: 9 });
    let unsafe = 0;
    const s = sim as unknown as { ns: { node: { idx: number; degree: number }; occ: { conn: { inEdge: { inArm: number }; outEdge: { outArm: number } } }[] }[]; peds: { crossing: number }[][] };
    for (let t = 0; t < 4000; t++) {
      sim.step();
      for (const st of s.ns) (s.peds[st.node.idx] ?? []).forEach((p, k) => {
        if (!p.crossing) return;
        const arms = st.node.degree === 2 ? [0, 1] : [k];
        if (st.occ.some(o => arms.includes(o.conn.inEdge.inArm) || arms.includes(o.conn.outEdge.outArm))) unsafe++;
      });
    }
    const crossed = sim.net.nodes.reduce((a, n) => a + (sim.pedStats(n.idx)?.crossed ?? 0), 0);
    return { trips: sim.stats.trips, crossed, unsafe, wait: sim.pedStats(sim.net.nodes[1].idx)?.avgWait ?? 0, towed: sim.stats.towed };
  };
  const without = run(0), withP = run(400);
  const ok = withP.crossed > 50 && withP.unsafe === 0 && withP.trips < without.trips && withP.trips > without.trips * 0.6 && withP.towed <= 1 && without.crossed === 0;
  console.log(`pedestrians: ${withP.crossed} crossed (zebra wait ${withP.wait.toFixed(1)} s), ${withP.unsafe} steps with a vehicle over a busy crossing; trips ${withP.trips} vs ${without.trips} without pedestrians, ${withP.towed} towed | ok ${ok}`);
  if (!ok) process.exit(1);
}

// two-lane roundabout: more traffic gets through than with one lane, nobody drives through anyone,
// and the first exit is taken from the outer lane, the rest from the inner lane
{
  const run = (lanes: 1 | 2) => {
    const R = { ...makeNode(0, 0, "roundabout", false), ...(lanes === 2 ? { ringLanes: 2 as const } : {}) };
    const E = makeNode(220, 0), W = makeNode(-220, 0), N = makeNode(0, -220), S = makeNode(0, 220);
    const net: Network = { version: 1, nodes: [R, E, W, N, S], stops: [], lines: [], links: [makeLink(E, R, 2, 2), makeLink(W, R, 2, 2), makeLink(N, R, 2, 2), makeLink(S, R, 2, 2)] };
    const c = compile(sanitizeNetwork(net)), sim = new Sim(c, { cars: 260, trucks: 10, seed: 4 });
    let overlap = 0, inner = 0, outerR = 0, wrong = 0;
    const seen = new Set<number>();
    for (let t = 0; t < 5000; t++) {
      sim.step();
      const by = new Map<number, { s: number; len: number }[]>();
      for (const v of sim.vehicles) if (!v.dead && v.piece.kind !== "lane") (by.get(v.piece.id) ?? by.set(v.piece.id, []).get(v.piece.id)!).push({ s: v.s, len: v.len });
      for (const list of by.values()) { list.sort((a, b) => a.s - b.s); for (let i = 1; i < list.length; i++) if (list[i].s - list[i].len < list[i - 1].s - 0.5) overlap++; }
      for (const v of sim.vehicles) if (!v.dead && v.piece.kind === "ring" && !seen.has(v.id)) {
        seen.add(v.id);
        const turn = v.queue.find(p => p.kind === "conn" && p.role === "exit") as { move: { turn: string } } | undefined ?? (v.piece as unknown as { move?: { turn: string } });
        const t0 = (turn as { move?: { turn: string } }).move?.turn;
        if (v.piece.lane === 1) inner++; else if (t0 === "R") outerR++;
        if (t0 && lanes === 2 && ((t0 === "R") !== (v.piece.lane === 0))) wrong++;
      }
    }
    return { trips: sim.stats.trips, towed: sim.stats.towed, overlap, inner, outerR, wrong };
  };
  const one = run(1), two = run(2);
  const ok = two.trips > one.trips && two.towed <= 2 && two.overlap === 0 && two.inner > 20 && two.outerR > 20 && two.wrong === 0;
  console.log(`two-lane roundabout: ${two.trips} trips vs ${one.trips} with one lane; inner lane ${two.inner}, outer (first exit) ${two.outerR}, ${two.wrong} in the wrong lane; ${two.overlap} overlaps, ${two.towed} towed | ok ${ok}`);
  if (!ok) process.exit(1);
}

// merging roads: a chain of pieces through bend points becomes one road; stops keep their place
{
  const A = makeNode(0, 0), P = makeNode(100, 0, "priority", false), Q = makeNode(200, 30, "priority", false), B = makeNode(300, 30);
  const l1 = makeLink(A, P, 2, 1, { name: "Main", signB: "yield" }), l2 = { ...makeLink(Q, P, 1, 2), c1: { x: 170, y: 30 }, c2: { x: 130, y: 0 } }, l3 = makeLink(Q, B, 2, 1, { turnsF: ["L", "S"] });
  const net: Network = { version: 1, nodes: [A, P, Q, B], stops: [{ id: "s1", name: "Stop", link: l2.id, dir: -1, pos: 0.5 }], lines: [], links: [l1, l2, l3] };
  const r = mergeLinks(net, [l1.id, l2.id, l3.id]);
  const ok1 = "net" in r && r.net.links.length === 1 && r.net.nodes.length === 2 && r.net.stops[0].link === r.id && r.net.stops[0].dir === 1 && Math.abs(r.net.stops[0].pos - 0.5) < 0.05
    && r.net.links[0].name === "Main" && r.net.links[0].signB === "yield" && r.net.links[0].turnsF?.join() === "L,S" && compile(sanitizeNetwork(r.net)).warnings.length === 0;
  // a junction in between, or different lanes: refused with a reason
  const C = makeNode(100, 80), withSide: Network = { ...net, nodes: [...net.nodes, C], links: [...net.links, makeLink(C, P)] };
  const r2 = mergeLinks(withSide, [l1.id, l2.id]), r3 = mergeLinks({ ...net, links: [l1, { ...l2, lanesF: 2 }, l3] }, [l1.id, l2.id]);
  const ok = ok1 && "error" in r2 && "error" in r3;
  console.log(`merge roads: ${"net" in r ? `1 road ${r.id}, stop at ${r.net.stops[0].pos.toFixed(2)}, shape within ${r.err.toFixed(1)} m` : r.error}; junction between: ${"error" in r2 ? "refused" : "merged!"}; different lanes: ${"error" in r3 ? "refused" : "merged!"} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// smoothing the join between two roads at a junction: their curves leave the shared point along one line
{
  const A = makeNode(-100, 20), J = makeNode(0, 0, "priority", false), B = makeNode(100, 30), C = makeNode(0, 100);
  const a = makeLink(A, J), b = makeLink(J, B), side = makeLink(J, C);
  const r = smoothBetween({ version: 1, nodes: [A, J, B, C], stops: [], lines: [], links: [a, b, side] }, a.id, b.id);
  let ok = false, dot = 0;
  if (!("error" in r)) {
    const la = r.links.find(l => l.id === a.id)!, lb = r.links.find(l => l.id === b.id)!, ls = r.links.find(l => l.id === side.id)!;
    const ha = la.c2!, hb = lb.c1!, u = { x: ha.x - J.x, y: ha.y - J.y }, w = { x: hb.x - J.x, y: hb.y - J.y };
    dot = (u.x * w.x + u.y * w.y) / (Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y));
    ok = dot < -0.999 && !ls.c1 && !ls.c2;
  }
  const r2 = smoothBetween({ version: 1, nodes: [A, J, B, C], stops: [], lines: [], links: [a, b, side] }, a.id, makeLink(B, C).id);
  ok = ok && "error" in r2;
  console.log(`smooth join: handles at the junction ${dot.toFixed(4)} (−1 = one line), third road untouched, roads that don't meet refused | ok ${ok}`);
  if (!ok) process.exit(1);
}

// a lane that ends: two lanes narrowing to one at a plain road point; traffic merges before the
// end of the taper (nobody drives past it, nobody overlaps) and flows at least as well as a sudden drop
{
  const run = (drop: boolean) => {
    const A = makeNode(-300, 0), P = makeNode(0, 0, "priority", false), B = makeNode(250, 0);
    const net: Network = { version: 1, nodes: [A, P, B], stops: [], lines: [], links: [makeLink(A, P, 2, 0, drop ? { dropF: { side: "right", len: 80 } } : {}), makeLink(P, B, 1, 0)] };
    const c = compile(sanitizeNetwork(net)), sim = new Sim(c, { cars: 70, trucks: 3, seed: 6 });
    const e = c.edges.find(x => x.n === 2)!;
    let past = 0, overlap = 0;
    for (let t = 0; t < 4000; t++) {
      sim.step();
      const by = new Map<number, { s: number; len: number }[]>();
      for (const v of sim.vehicles) {
        if (v.dead) continue;
        if (drop && v.piece.kind === "lane" && v.piece.edge === e && v.lane === e.dropLane && v.s > e.dropStop * (v.piece.len / e.length) + 0.5) past++;
        (by.get(v.piece.id) ?? by.set(v.piece.id, []).get(v.piece.id)!).push({ s: v.s, len: v.len });
      }
      for (const list of by.values()) { list.sort((a, b) => a.s - b.s); for (let i = 1; i < list.length; i++) if (list[i].s - list[i].len < list[i - 1].s - 0.5) overlap++; }
    }
    return { trips: sim.stats.trips, towed: sim.stats.towed, past, overlap, shape: drop ? e.dropLane === 1 && e.dropEnd > e.dropFrom : true };
  };
  const sudden = run(false), merge = run(true);
  // (a sudden drop "flows" by letting both lanes squeeze through each other: it overlaps)
  const ok = merge.shape && merge.past === 0 && merge.overlap === 0 && merge.towed === 0 && merge.trips >= sudden.trips * 0.8;
  console.log(`lane ends: ${merge.trips} trips, ${merge.past} past the end of the taper, ${merge.overlap} overlaps, ${merge.towed} towed (a sudden drop: ${sudden.trips} trips with ${sudden.overlap} overlaps) | ok ${ok}`);
  if (!ok) process.exit(1);
}

// road event log: records what vehicles do on a road, and recording changes nothing
{
  // (each run its own compiled network: bus stops keep their waiting passengers on it)
  const town = sampleTown(), c = compile(town), busy = c.edges.slice().sort((a, b) => b.n - a.n || b.length - a.length)[0].link.id;
  const a = new Sim(c, { cars: 120, trucks: 6, seed: 7 }), b = new Sim(compile(town), { cars: 120, trucks: 6, seed: 7 });
  b.logLinks = new Set([busy]);
  a.run(3000); b.run(3000);
  const ev = b.events.filter(e => e.link === busy), kinds = new Set(ev.map(e => e.kind));
  const same = a.stats.trips === b.stats.trips && a.vehicles.filter(v => !v.dead).map(v => `${v.id}:${v.s.toFixed(3)}`).join() === b.vehicles.filter(v => !v.dead).map(v => `${v.id}:${v.s.toFixed(3)}`).join();
  const ok = same && ev.length > 20 && kinds.has("state") && (kinds.has("enter-road") || kinds.has("appear")) && (kinds.has("leave-road") || kinds.has("exit")) && a.events.every(e => !e.link);
  console.log(`road event log: ${ev.length} events on ${busy} (${[...kinds].join(", ")}); run unchanged ${same} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// free junction: two two-lane roads joining one lane. Vehicles waiting at the line take turns, so
// every entering lane gets its share (nobody on its way jumps them), and they zip in without overlapping
{
  const J = makeNode(0, 0, "free", false), A = makeNode(-200, -60), B = makeNode(-200, 60), X = makeNode(250, 0);
  const net: Network = { version: 1, nodes: [J, A, B, X], stops: [], lines: [], links: [makeLink(A, J, 2, 0), makeLink(B, J, 2, 0), makeLink(J, X, 1, 0)] };
  const c = compile(sanitizeNetwork(net)), sim = new Sim(c, { cars: 200, trucks: 0, seed: 3 });
  sim.logAll = true;
  let overlap = 0;
  for (let t = 0; t < 5000; t++) {
    sim.step();
    const on = sim.vehicles.filter(v => !v.dead && v.piece.kind === "conn");
    for (let i = 0; i < on.length; i++) for (let k = i + 1; k < on.length; k++) {
      const p = on[i].piece.poly.at(on[i].s), q = on[k].piece.poly.at(on[k].s);
      if (Math.hypot(p.x - q.x, p.y - q.y) < 3) overlap++;
    }
  }
  const grants = new Map<string, number>(); let maxWait = 0;
  for (const e of sim.events) if (e.kind === "grant" && e.node === J.id) {
    const k = `${e.data?.from} ${e.data?.lane}`; grants.set(k, (grants.get(k) ?? 0) + 1);
    maxWait = Math.max(maxWait, +(/waited ([\d.]+)/.exec(e.detail)?.[1] ?? 0));
  }
  const counts = [...grants.values()], total = counts.reduce((s, n) => s + n, 0);
  const ok = grants.size === 4 && counts.every(n => n > total / 8) && maxWait < 60 && overlap === 0 && sim.stats.towed === 0;
  console.log(`free junction: ${total} through, per entering lane ${counts.join("/")}, longest wait ${maxWait.toFixed(0)} s; ${overlap} overlaps, ${sim.stats.towed} towed | ok ${ok}`);
  if (!ok) process.exit(1);
}
