import { Sim, sampleTown, compile, connectorPreview, throughConns, connShapeKey, currentTargets, laneAllowed, exitLanesOf, exitLane, connectionIssues, alignableNodes, measureRun, optimizeSignals } from "../src/engine";
import { Poly } from "../src/engine/geom";
import { changeConnection, connectLanes, lanesLeavingNear, writeOut } from "../src/state/connections";
import { carriagewayRun, splitCarriageways, type Run } from "../src/state/carriageways";
import { Recorder } from "../src/engine/sim/recorder";
import { makeLink, makeNode } from "../src/engine/sample";
import { isJunction } from "../src/engine/refs";
import * as mirrorModule from "../src/engine/sim/mirror";
import { readFileSync } from "fs";
import { sanitizeNetwork, sanitizeSettings } from "../src/engine/validate";
import { DEFAULT_PARAMS } from "../src/engine/params";
import { polyCentroid } from "../src/engine/buildings";
import type { Network } from "../src/engine/types";
import { customizePhases, addPhase, approachesTo, toConnectorPhases, setConnGreen, setLaneGreen, reverseLink, splitLink, linkPoint, nodeById, addSlipLane, mergeLinks, smoothBetween } from "../src/state/ops";
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

// vehicle event log: records one vehicle's events at junctions and on roads (nobody else's), and recording changes nothing
{
  const town = sampleTown();
  const cb = compile(town), a = new Sim(compile(town), { cars: 120, trucks: 6, seed: 7 }), b = new Sim(cb, { cars: 120, trucks: 6, seed: 7 });
  a.run(300); b.run(300);
  const id = b.vehicles.filter(v => !v.dead).sort((x, y) => x.id - y.id)[0].id;
  b.logVehicles = new Set([id]);
  a.run(2000); b.run(2000);
  const ev = b.events, kinds = new Set(ev.map(e => e.kind));
  const same = a.stats.trips === b.stats.trips && a.vehicles.filter(v => !v.dead).map(v => `${v.id}:${v.s.toFixed(3)}`).join() === b.vehicles.filter(v => !v.dead).map(v => `${v.id}:${v.s.toFixed(3)}`).join();
  const ok = same && ev.length > 3 && ev.every(e => e.veh === id) && ev.some(e => e.node) && ev.some(e => e.link) && a.events.length === 0
    && ev.every(e => !e.node || isJunction(cb.nodeById.get(e.node)!)) && ev.every(e => !/\bn_\w+/.test(e.detail) || /(joint|entry\/exit|node) n_/.test(e.detail));
  console.log(`vehicle event log: ${ev.length} events for #${id} (${[...kinds].join(", ")}); run unchanged ${same} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// two junctions close together (2 m apart on a main road, side roads giving way): vehicles ask the
// second while still crossing the first, so they don't slow down for its line before they may even
// ask. Before, they crossed at walking pace and the pair locked up, getting vehicles towed.
{
  const W = makeNode(-250, 0), E = makeNode(260, 0), N = makeNode(0, -200), S = makeNode(10, 200);
  const J1 = makeNode(0, 0, "priority", false), J2 = makeNode(10, 0, "priority", false);
  const net: Network = { version: 1, nodes: [W, J1, J2, E, N, S], stops: [], lines: [], links: [makeLink(W, J1, 1, 1), makeLink(J1, J2, 1, 1), makeLink(J2, E, 1, 1), makeLink(N, J1, 1, 1, { signF: "yield" }), makeLink(J2, S, 1, 1, { signB: "yield" })] };
  const c = compile(sanitizeNetwork(net)), mid = c.edges.filter(e => e.from.controlled && e.to.controlled);
  const sim = new Sim(c, { cars: 30, trucks: 0, seed: 5 });
  sim.logAll = true;
  const seen = new Set<number>(); let n = 0, sum = 0, overlap = 0;
  for (let t = 0; t < 6000; t++) {
    sim.step();
    for (const v of sim.vehicles) {
      if (v.dead || v.piece.kind !== "lane" || !mid.includes(v.piece.edge) || seen.has(v.id * 2 + v.piece.edge.dir)) continue;
      seen.add(v.id * 2 + v.piece.edge.dir);
      const from = v.trail[0];
      if (from.kind === "conn" && from.move.turn === "S") { n++; sum += v.v * 3.6; }
    }
    const on = sim.vehicles.filter(v => !v.dead && v.piece.kind === "conn");
    for (let i = 0; i < on.length; i++) for (let k = i + 1; k < on.length; k++) {
      const p = on[i].piece.poly.at(on[i].s), q = on[k].piece.poly.at(on[k].s);
      if (Math.hypot(p.x - q.x, p.y - q.y) < 1.5) overlap++;
    }
  }
  const early = sim.events.filter(e => e.kind === "request" && e.detail.includes("asked early")).length, avg = sum / Math.max(1, n);
  const ok = mid.length === 2 && mid[0].length < 10 && n > 40 && avg > 14 && early > 50 && overlap === 0 && sim.stats.towed === 0 && sim.stats.trips > 150;
  console.log(`close junctions: ${mid.map(e => e.length.toFixed(1)).join("/")} m apart; ${n} vehicles straight on onto the road between at ${avg.toFixed(1)} km/h on average; ${early} early requests, ${sim.stats.trips} trips, ${sim.stats.towed} towed, overlaps ${overlap} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// reversible middle lane along a corridor of two roads through a junction: lane 0 of both directions is
// the same strip; it opens one way at a time (timer, traffic each way, or by hand), closing waits until the
// vehicles in it have driven out, and nobody is ever in it the wrong way or while closed
{
  const corridor = (mode: "timer" | "dynamic" | "manual", r1: number, r2: number) => {
    const W = makeNode(-400, 0), E = makeNode(400, 0), N = makeNode(0, -250), J = makeNode(0, 0, "priority", false);
    const net = sanitizeNetwork({
      version: 1, nodes: [W, J, E, N], stops: [], lines: [],
      links: [{ ...makeLink(W, J, 1, 1), rev: "c1" }, { ...makeLink(J, E, 1, 1), rev: "c1" }, makeLink(N, J, 1, 1, { signF: "yield" })],
      reversibles: [{ id: "c1", name: "T", start: W.id, mode, open1: 120, open2: 120, gap: 5, minDensity: 12, ratio: 1.5, minOpen: 60, initial: "closed" }],
      flows: [{ id: "f1", from: W.id, to: E.id, rate: r1 }, { id: "f2", from: E.id, to: W.id, rate: r2 }],
    });
    return { c: compile(net), J };
  };
  const drive = (sim: Sim, ticks: number, cmds: [number, "closed" | "1" | "2" | "auto"][] = []) => {
    const seq: number[] = []; let wrong = 0; const used = [0, 0];
    for (let t = 0; t < ticks; t++) {
      for (const [at, cmd] of cmds) if (at === t) sim.reversibleCommand(0, cmd);
      sim.step();
      const s = sim.reversibleState(0)!.state;
      if (seq[seq.length - 1] !== s) seq.push(s);
      for (const v of sim.vehicles) {
        if (v.dead || v.piece.kind !== "lane" || v.piece.lane !== 0 || !v.piece.edge.rev) continue;
        const d = v.piece.edge.cdir;
        if ((d === 1 && s !== 1 && s !== 2) || (d === 2 && s !== 3 && s !== 4)) wrong++;
        used[d - 1]++;
      }
    }
    return { seq: seq.join(""), wrong, used };
  };
  const { c, J } = corridor("timer", 900, 500), cc = c.corridors[0];
  const [f0, b0] = [cc.edges[0][0], cc.edges[1][cc.edges[1].length - 1]];
  const shared = f0.rev && b0.rev && f0.n === 2 && Math.abs(f0.lanes[0].offset) < 0.01 && Math.abs(b0.lanes[0].offset) < 0.01;
  // turns from the fixed lanes only; straight on from both
  const moves = c.nodeById.get(J.id)!.moves.get(f0.idx) ?? [];
  const turnsOk = moves.every(m => (m.turn === "S" ? m.lo === 0 && m.hi === 1 : m.lo === 1));
  const sim = new Sim(c, { cars: 0, trucks: 0, seed: 4 }), timer = drive(sim, 9000);
  const dyn1 = drive(new Sim(corridor("dynamic", 1400, 300).c, { cars: 0, trucks: 0, seed: 4 }), 3000);
  const dyn2 = drive(new Sim(corridor("dynamic", 300, 1400).c, { cars: 0, trucks: 0, seed: 4 }), 3000);
  const man = drive(new Sim(corridor("manual", 800, 800).c, { cars: 0, trucks: 0, seed: 4 }), 7000, [[300, "1"], [3000, "2"], [6000, "closed"]]);
  const ok = shared && turnsOk && c.warnings.length === 0 && timer.seq.startsWith("120340120") && timer.wrong === 0 && timer.used[0] > 0 && timer.used[1] > 0 && sim.stats.towed === 0
    && dyn1.seq.startsWith("01") && dyn2.seq.startsWith("03") && dyn1.wrong + dyn2.wrong === 0 && man.seq.startsWith("0120340") && man.wrong === 0;
  console.log(`reversible lane: shared strip ${shared}, turns ${turnsOk}; timer ${timer.seq} (in it ${timer.used.join("/")} vehicle-ticks, wrong way ${timer.wrong}, towed ${sim.stats.towed}); dynamic ${dyn1.seq} / ${dyn2.seq}; by hand ${man.seq} | ok ${ok}`);
  if (!ok) process.exit(1);

  // set by hand in the plan's settings: a timer corridor (open to 1 at the start) closes at once, opens to 2 and stays so
  const held = new Sim(corridor("timer", 800, 800).c, { cars: 0, trucks: 0, seed: 4, revHold: { c1: "2" } });
  const h = drive(held, 6000);
  // a replay frame shows the lane as it was at that step
  const rs = new Sim(corridor("timer", 800, 800).c, { cars: 0, trucks: 0, seed: 4 }), rr = new Recorder();
  const seen: { tick: number; state: number; inside: number; t: number }[] = [];
  for (let t = 0; t < 3000; t++) { rs.step(); rr.record(rs); if (t % 97 === 0) { const x = rs.reversibleState(0)!; seen.push({ tick: rs.tick, state: x.state, inside: x.inside, t: x.t }); } }
  const replayOk = seen.every(x => { const r = rr.frameAt(x.tick, rs)?.rev?.[0]; return !!r && r.state === x.state && r.inside === Math.min(255, x.inside) && Math.abs(r.t - x.t) < 0.11; });
  const ok2 = h.seq === "203" && h.wrong === 0 && held.reversibleState(0)!.hold === "2" && replayOk && new Set(seen.map(x => x.state)).size >= 3;
  console.log(`reversible lane kept as set by hand: ${h.seq}; in replay frames ${replayOk} (${seen.length} steps compared) | ok ${ok2}`);
  if (!ok2) process.exit(1);
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

// simulation settings: the defaults are the engine's own values (stored settings keep only changes),
// a changed value changes the run, and new settings reach a running simulation
{
  const network = sampleTown(), settings = { cars: 150, trucks: 10, seed: 5 };
  const run = (params?: object) => { const s = new Sim(network, { ...settings, ...(params ? { params } : {}) }); s.run(1500); return s; };
  const a = run(), b = run({ ...DEFAULT_PARAMS }), fast = run({ junctionSpeed: 1.6, carHeadway: 0.6 });
  const stored = sanitizeSettings({ ...settings, params: { ...DEFAULT_PARAMS, towAfter: 90, bogus: 3, ringGap: 99 } }).params;
  const live = new Sim(network, settings); live.settings = { ...settings, params: { towAfter: 60 } };
  const ok = a.stats.trips === b.stats.trips && a.stats.laneChanges === b.stats.laneChanges && fast.stats.trips !== a.stats.trips
    && JSON.stringify(stored) === JSON.stringify({ ringGap: 6, towAfter: 90 }) && live.P.towAfter === 60 && live.P.ringGap === DEFAULT_PARAMS.ringGap;
  console.log(`simulation settings: defaults ${a.stats.trips} = ${b.stats.trips} trips, faster junctions + shorter gaps ${fast.stats.trips}; stored ${JSON.stringify(stored)}; live update ${live.P.towAfter} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// lanes added at a plain road point: a two-way road's lane (right of its centre line) carries on into
// the right lane of a two-lane one-way road, not across into its left lane; the reverse drop too
{
  const A = makeNode(-200, 0), P = makeNode(0, 0, "priority", false), B = makeNode(200, 0);
  const into = compile(sanitizeNetwork({ version: 1, nodes: [A, P, B], stops: [], lines: [], links: [makeLink(A, P, 1, 1), makeLink(P, B, 2, 0)] }));
  const mIn = [...into.nodeById.get(P.id)!.moves.values()].flat().find(m => m.out.n === 2)!;
  const outOf = compile(sanitizeNetwork({ version: 1, nodes: [A, P, B], stops: [], lines: [], links: [makeLink(A, P, 2, 0), makeLink(P, B, 1, 1)] }));
  const mOut = [...outOf.nodeById.get(P.id)!.moves.values()].flat().find(m => m.in.n === 2)!;
  const ok = exitLane(mIn, 0, false) === 1 && exitLane(mOut, 1, false) === 0 && mOut.skip === 1;
  console.log(`lanes added / dropped at a road point: 1 lane → right lane of 2: ${exitLane(mIn, 0, false) === 1}; 2 → 1 keeps the right lane: ${mOut.skip === 1} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// entry / exit point counters: every vehicle coming in or leaving through one is counted, with a rate per hour
{
  const s = new Sim(sampleTown(), { cars: 150, trucks: 10, seed: 5 });
  s.run(4000);
  const ins = [...s.entered.values()].reduce((a, b) => a + b, 0), outs = [...s.exited.values()].reduce((a, b) => a + b, 0);
  const rates = s.gateRates(), anyIn = rates.some(([, a]) => a > 0), anyOut = rates.some(([, , b]) => b > 0);
  const ok = ins > 20 && outs > 20 && outs <= s.stats.trips && anyIn && anyOut;
  console.log(`entry / exit counters: ${ins} entered, ${outs} left (${s.stats.trips} trips); busiest ${Math.round(Math.max(...rates.map(r => r[1])))}/h in | ok ${ok}`);
  if (!ok) process.exit(1);
}

// lane connections set by hand: they win over the automatic ones, a swap is reported as crossing
// paths, a turn with every lane switched off is gone, the check finds roads that lead nowhere
{
  const J = makeNode(0, 0, "priority", false), W = makeNode(-200, 0), E = makeNode(200, 0), S = makeNode(0, 200);
  const we = makeLink(W, J, 2, 2), je = makeLink(J, E, 2, 2), js = makeLink(J, S, 1, 1);
  const base: Network = { version: 1, nodes: [J, W, E, S], stops: [], lines: [], links: [we, je, js] };
  const kS = `${we.id}:1>${je.id}:1`, kR = `${we.id}:1>${js.id}:1`;
  const auto = compile(sanitizeNetwork(base));
  const withMap = sanitizeNetwork({ ...base, nodes: base.nodes.map(n => n.id === J.id ? { ...n, laneMap: { [kS]: [1, 0], [kR]: [null, null], "bad key": [0] } } : n) });
  const c = compile(withMap), cn = c.nodeById.get(J.id)!, fromW = cn.moves.get(c.edgeByKey.get(`${we.id}:1`)!.idx)!;
  const mS = fromW.find(m => m.turn === "S")!;
  const issues = connectionIssues(c, cn);
  const autoIssues = connectionIssues(auto, auto.nodeById.get(J.id)!);
  const sim = new Sim(c, { cars: 120, trucks: 0, seed: 2 }); sim.run(3000);
  // every turn from the side road switched off: that road leads nowhere
  const offS = Object.fromEntries([we, je].map(l => [`${js.id}:-1>${l.id}:${l === we ? -1 : 1}`, [null]]));
  const dead = compile(sanitizeNetwork({ ...base, nodes: base.nodes.map(n => n.id === J.id ? { ...n, laneMap: offS } : n) }));
  const deadIssues = connectionIssues(dead, dead.nodeById.get(J.id)!);
  const kept = Object.keys(withMap.nodes.find(n => n.id === J.id)!.laneMap ?? {});
  const ok = exitLane(mS, 0, false) === 1 && exitLane(mS, 1, false) === 0 && !fromW.some(m => m.turn === "R")
    && issues.some(i => i.message.includes("cross")) && autoIssues.length === 0 && sim.stats.trips > 20
    && kept.length === 2 && deadIssues.some(i => i.level === "error" && /leads nowhere/.test(i.message));
  console.log(`lane connections by hand: straight lanes swapped ${exitLane(mS, 0, false)}/${exitLane(mS, 1, false)}, right turn gone ${!fromW.some(m => m.turn === "R")}; issues ${issues.map(i => i.message).join(" | ")}; automatic: ${autoIssues.length}; ${sim.stats.trips} trips | ok ${ok}`);
  if (!ok) process.exit(1);
}

// a junction's shape comes from its lanes: every lane path through a junction stays on its asphalt
{
  const c = compile(sanitizeNetwork(JSON.parse(readFileSync("scripts/fixtures/osm-milton-keynes.json", "utf8"))));
  const inside = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => {
    let r = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) r = !r;
    return r;
  };
  let paths = 0, off = 0;
  for (const v of connectorPreview(c, n => n.degree >= 2)) {
    paths++;
    const pts = v.pts, poly = v.node.polygon;
    // (the ends sit on the mouth line; look at the path in between)
    for (let i = 4; i + 5 < pts.length; i += 2) if (!inside({ x: pts[i], y: pts[i + 1] }, poly)) { off++; break; }
  }
  const ok = paths > 300 && off === 0;
  console.log(`junction shapes from lanes: ${paths} lane paths through junctions, ${off} leaving the road | ok ${ok}`);
  if (!ok) process.exit(1);
}

// connector shapes set by hand: the path takes the new handles, the junction outline still covers it,
// and bad values are dropped on load
{
  const J = makeNode(0, 0, "priority", false), W = makeNode(-200, 0), N = makeNode(0, -200), E = makeNode(200, 0);
  const wj = makeLink(W, J, 1, 1), jn = makeLink(J, N, 1, 1), je = makeLink(J, E, 1, 1);
  const base: Network = { version: 1, nodes: [J, W, N, E], stops: [], lines: [], links: [wj, jn, je] };
  const key = `${wj.id}:1|0>${jn.id}:1|0`;
  const c0 = compile(sanitizeNetwork(base));
  const shaped = sanitizeNetwork({ ...base, nodes: base.nodes.map(n => n.id === J.id ? { ...n, connShape: { [key]: [12, 12], "nope": [1, 2], [`${wj.id}:1|0>${je.id}:1|0`]: [NaN, 3] } } : n) });
  const c1 = compile(shaped);
  const path = (c: typeof c0) => connectorPreview(c).find(v => v.move.in.link.id === wj.id && v.move.out.link.id === jn.id)!;
  const p0 = path(c0), p1 = path(c1), mid = (v: typeof p0) => { const k = (v.pts.length / 4) | 0; return { x: v.pts[k * 2], y: v.pts[k * 2 + 1] }; };
  const moved = Math.hypot(mid(p0).x - mid(p1).x, mid(p0).y - mid(p1).y);
  const inside = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => { let r = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) r = !r; return r; };
  let off = 0; for (let i = 4; i + 5 < p1.pts.length; i += 2) if (!inside({ x: p1.pts[i], y: p1.pts[i + 1] }, p1.node.polygon)) off++;
  const kept = Object.keys(shaped.nodes.find(n => n.id === J.id)!.connShape ?? {});
  const sim = new Sim(c1, { cars: 60, trucks: 0, seed: 3 }); sim.run(2000);
  const ok = moved > 1 && off === 0 && kept.length === 1 && kept[0] === key && sim.stats.trips > 10;
  console.log(`connector shapes by hand: path moved ${moved.toFixed(1)} m, ${off} points off the road, kept ${kept.length} shape; ${sim.stats.trips} trips | ok ${ok}`);
  if (!ok) process.exit(1);
}

// junction editor: an outline drawn by hand replaces the automatic one (with a kerb band inside it),
// painted areas and lane lines are kept, free connector handles bend the path, bad data is dropped
{
  const J = makeNode(0, 0, "priority", false), W = makeNode(-200, 0), N = makeNode(0, -200), E = makeNode(200, 0);
  const wj = makeLink(W, J, 1, 1), jn = makeLink(J, N, 1, 1), je = makeLink(J, E, 1, 1);
  const square = [{ x: -12, y: -12 }, { x: 12, y: -12 }, { x: 12, y: 12 }, { x: -12, y: 12 }];
  const key = `${wj.id}:1|0>${jn.id}:1|0`;
  const net = sanitizeNetwork({ version: 1, nodes: [{ ...J, outline: square, laneLines: true, paint: [{ kind: "hatch", pts: [{ x: 2, y: 2 }, { x: 5, y: 2 }, { x: 4, y: 5 }] }, { kind: "bogus", pts: [] }], connShape: { [key]: { c1: { x: -2, y: 8 }, c2: { x: 8, y: -2 } } } }, W, N, E], stops: [], lines: [], links: [wj, jn, je] } as Network);
  const nd = net.nodes.find(n => n.id === J.id)!;
  const c = compile(net), cn = c.nodeById.get(J.id)!;
  const area = (p: { x: number; y: number }[]) => { let A = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) A += (p[j].x + p[i].x) * (p[j].y - p[i].y); return Math.abs(A / 2); };
  const v = connectorPreview(c).find(x => x.move.in.link.id === wj.id && x.move.out.link.id === jn.id)!;
  const auto = connectorPreview(compile(sanitizeNetwork({ ...net, nodes: net.nodes.map(n => n.id === J.id ? { ...n, connShape: undefined } : n) }))).find(x => x.move.in.link.id === wj.id && x.move.out.link.id === jn.id)!;
  const k = (v.pts.length / 4) | 0, moved = Math.hypot(v.pts[k * 2] - auto.pts[k * 2], v.pts[k * 2 + 1] - auto.pts[k * 2 + 1]);
  const geo = buildRoadGeo(c, net);
  const ok = Math.abs(area(cn.polygon) - 576) < 1 && area(cn.surface) < 576 && area(cn.surface) > 400 && nd.paint?.length === 1 && nd.laneLines === true
    && moved > 0.5 && geo.lines.some(l => l.kind === "hatch");
  console.log(`junction editor: outline ${area(cn.polygon).toFixed(0)} m² (asphalt ${area(cn.surface).toFixed(0)}), ${nd.paint?.length} painted area, free handles moved the path ${moved.toFixed(1)} m | ok ${ok}`);
  if (!ok) process.exit(1);
}

// line up lanes: a two-way road splitting into two one-way carriageways; with it on, the one-way roads'
// lanes continue where each direction's lanes are, so the straight-on paths hardly shift sideways
{
  const J = makeNode(0, 0, "priority", false), E = makeNode(200, 0), NW = makeNode(-200, -12), SW = makeNode(-200, 12);
  const main = makeLink(J, E, 2, 2), out = makeLink(J, NW, 2, 0), inn = makeLink(SW, J, 2, 0);
  const base: Network = { version: 1, nodes: [J, E, NW, SW], stops: [], lines: [], links: [main, out, inn] };
  const shift = (net: Network) => {
    const c = compile(sanitizeNetwork(net)); let worst = 0;
    // how far each straight-on path ends up to the side of where it started (the main road runs along x)
    for (const v of connectorPreview(c)) if (v.move.turn === "S") { const P = v.pts; worst = Math.max(worst, Math.abs(P[P.length - 1] - P[1])); }
    return worst;
  };
  const before = shift(base), after = shift({ ...base, nodes: base.nodes.map(n => (n.id === J.id ? { ...n, align: true } : n)) });
  const ok = before > 0.5 && after < 0.1 && alignableNodes(base).includes(J.id);
  console.log(`line up lanes: straight-on paths end up to ${before.toFixed(2)} m to the side → ${after.toFixed(2)} m | ok ${ok}`);
  if (!ok) process.exit(1);
}

// junction outlines worked out elsewhere: a compile with outlines "cached" lists the missing ones, and
// once a full compile has worked them out it uses the very same shapes; simulation runs don't need them
{
  const net = sanitizeNetwork(sampleTown());
  // (moved a little, so none of these junctions are in the shape cache from earlier checks)
  const moved = { ...net, nodes: net.nodes.map(n => ({ ...n, x: n.x + 0.37, y: n.y - 0.21 })) };
  const cold = compile(moved, { outlines: "cached" }), full = compile(moved), warm = compile(moved, { outlines: "cached" });
  const same = full.nodes.every((n, i) => JSON.stringify(n.polygon) === JSON.stringify(warm.nodes[i].polygon) && JSON.stringify(n.surface) === JSON.stringify(warm.nodes[i].surface));
  const a = new Sim(compile(moved, { outlines: false }), { cars: 120, trucks: 5, seed: 9 }), b = new Sim(full, { cars: 120, trucks: 5, seed: 9 });
  a.run(1500); b.run(1500);
  const ok = cold.pendingShapes.length > 0 && warm.pendingShapes.length === 0 && same && a.stats.trips === b.stats.trips && a.stats.laneChanges === b.stats.laneChanges;
  console.log(`outlines cached: ${cold.pendingShapes.length} missing at first, ${warm.pendingShapes.length} once worked out, same shapes ${same}; simulation without outlines identical ${a.stats.trips === b.stats.trips} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// adding a lane connector by hand where no turn existed (here the lane arrows leave out the right turn):
// the turn comes back, only from that lane, classed by its angle, and traffic uses it
{
  const J = makeNode(0, 0, "priority", false), W = makeNode(-200, 0), E = makeNode(200, 0), S = makeNode(0, 200);
  const wj = makeLink(W, J, 2, 2, { turnsF: ["S", "S"] }), je = makeLink(J, E, 2, 2), js = makeLink(J, S, 1, 1);
  const base: Network = { version: 1, nodes: [J, W, E, S], stops: [], lines: [], links: [wj, je, js] };
  const before = compile(sanitizeNetwork(base)), inKey = `${wj.id}:1`;
  const had = (before.nodeById.get(J.id)!.moves.get(before.edgeByKey.get(inKey)!.idx) ?? []).some(m => m.out.link.id === js.id);
  const net = sanitizeNetwork({ ...base, nodes: base.nodes.map(n => (n.id === J.id ? { ...n, laneMap: { [`${inKey}>${js.id}:1`]: [null, 0] } } : n)) });
  const c = compile(net), m = (c.nodeById.get(J.id)!.moves.get(c.edgeByKey.get(inKey)!.idx) ?? []).find(x => x.out.link.id === js.id);
  const sim = new Sim(c, { cars: 150, trucks: 0, seed: 4 }); sim.run(3000);
  const used = sim.turnCounts.get(`${c.edgeByKey.get(inKey)!.idx}>${c.edgeByKey.get(`${js.id}:1`)!.idx}`) ?? 0;
  const ok = !had && !!m && m.turn === "R" && m.lo === 1 && m.hi === 1 && exitLane(m, 1, false) === 0 && used > 0;
  console.log(`add a lane connector: turn before ${had}, after ${m ? `${m.turn} from lane ${m.lo + 1}` : "none"}, taken ${used} times | ok ${ok}`);
  if (!ok) process.exit(1);
}

// lane arrows "ahead" on a road merging at an angle (no straight movement there): ahead means carrying
// on into the road it merges with, so the arrows apply (and leave out the turn back the other way)
{
  const J = makeNode(0, 0, "priority", false), N = makeNode(0, -200), S = makeNode(0, 200), W = makeNode(-150, -120);
  const ns = makeLink(N, J, 2, 2), js = makeLink(J, S, 2, 2), wj = makeLink(W, J, 1, 0, { turnsF: ["S"] });
  const c = compile(sanitizeNetwork({ version: 1, nodes: [J, N, S, W], stops: [], lines: [], links: [ns, js, wj] }));
  const moves = c.nodeById.get(J.id)!.moves.get(c.edgeByKey.get(`${wj.id}:1`)!.idx) ?? [];
  const ok = moves.length === 1 && moves[0].out.link.id === js.id && !c.warnings.some(w => /lane arrows/.test(w));
  console.log(`arrows ahead on a merge: ${moves.map(m => `${m.turn} to ${m.out.link.id === js.id ? "south" : "north"}`).join(", ")}; warnings ${c.warnings.length} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// a lane beside a curved road keeps its direction to its very end: a cut a hair from a vertex of the
// centre line used to leave a near-zero segment that the offset turned around (a connector then looped back)
{
  const pts: number[] = [];
  for (let k = 0; k <= 60; k++) { const t = (k / 60) * 1.2; pts.push(Math.sin(t) * 120, -Math.cos(t) * 120); }
  const line = new Poly(pts), vertex = line.cum[50];
  let worst = 1;
  for (const gap of [0.005, 0.011, 0.015, 0.03, 0.1]) {
    const lane = line.slice(0, vertex + gap).offset(8), t = lane.tangent(lane.len), c = line.tangent(vertex + gap);
    worst = Math.min(worst, t.x * c.x + t.y * c.y);
  }
  const ok = worst > 0.99;
  console.log(`lane end direction after a cut near a vertex: worst alignment ${worst.toFixed(3)} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// a connector drawn from the end of a lane to a lane leaving the junction (lane inspector / map)
{
  const J = makeNode(0, 0, "priority", false), W = makeNode(-200, 0), E = makeNode(200, 0), S = makeNode(0, 200);
  const wj = makeLink(W, J, 2, 2, { turnsF: ["S", "S"] }), je = makeLink(J, E, 2, 2), js = makeLink(J, S, 1, 1);
  const net = sanitizeNetwork({ version: 1, nodes: [J, W, E, S], stops: [], lines: [], links: [wj, je, js] });
  const r = connectLanes(net, compile(net), `${wj.id}:1`, 1, `${js.id}:1`, 0);
  const c = r && compile(sanitizeNetwork(r.net)), m = c ? (c.nodeById.get(J.id)!.moves.get(c.edgeByKey.get(`${wj.id}:1`)!.idx) ?? []).find(x => x.out.link.id === js.id) : undefined;
  const ok = !!r && !!m && m.lo === 1 && m.hi === 1 && r.id === `${J.id}|${wj.id}:1|1|${js.id}:1|0`;
  console.log(`connector drawn from a lane: ${m ? `${m.turn} from lane ${m.lo + 1}` : "none"}, selects ${r?.id} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// one lane feeding several lanes of the exit (connectors drawn by hand): each is a connector, adding one
// keeps the others, removing one keeps the rest, and traffic uses them
{
  const J = makeNode(0, 0, "priority", false), W = makeNode(-200, 0), E = makeNode(200, 0), N = makeNode(0, -200);
  const wj = makeLink(W, J, 1, 1), je = makeLink(J, E, 3, 3), jn = makeLink(J, N, 1, 1);
  const base = sanitizeNetwork({ version: 1, nodes: [J, W, E, N], stops: [], lines: [], links: [wj, je, jn] });
  const inKey = `${wj.id}:1`, outKey = `${je.id}:1`;
  const r1 = connectLanes(base, compile(base), inKey, 0, outKey, 1)!;   // lane 1 → exit lane 2 (adds to → 1)
  const r2 = connectLanes(r1.net, compile(sanitizeNetwork(r1.net)), inKey, 0, outKey, 2)!; // and → 3
  const net = sanitizeNetwork(r2.net), c = compile(net);
  const lane0 = (nw: Network) => nw.nodes.find(n => n.id === J.id)!.connectors!.filter(x => x.in === inKey && x.out === outKey && x.a === 0).map(x => x.b);
  const targets = lane0(net);
  const views = connectorPreview(c).filter(v => v.move.in.key === inKey && v.move.out.key === outKey).map(v => v.outLane).sort();
  const removed = lane0(sanitizeNetwork(changeConnection(net, c, inKey, 0, outKey, 1, null)));
  const sim = new Sim(c, { cars: 120, trucks: 0, seed: 5 }); let overlap = 0;
  for (let t = 0; t < 3000; t++) { sim.step(); const on = sim.vehicles.filter(v => !v.dead && v.piece.kind === "conn");
    for (let i = 0; i < on.length; i++) for (let k = i + 1; k < on.length; k++) { const p = on[i].piece.poly.at(on[i].s), q = on[k].piece.poly.at(on[k].s); if (Math.hypot(p.x - q.x, p.y - q.y) < 2) overlap++; } }
  const ok = JSON.stringify(targets) === "[0,1,2]" && views.join() === "0,1,2" && JSON.stringify(removed) === "[0,2]" && sim.stats.trips > 10 && overlap === 0;
  console.log(`one lane to several: targets ${JSON.stringify(targets)}, connectors to ${views.join(",")}, after removing one ${JSON.stringify(removed)}; ${sim.stats.trips} trips, ${overlap} overlaps | ok ${ok}`);
  if (!ok) process.exit(1);
}

// replay: every step is kept; a kept step shows the vehicles where they were then (and the lights);
// over the memory budget the oldest steps go
{
  const s = new Sim(sampleTown(), { cars: 150, trucks: 10, seed: 3 }), rec = new Recorder();
  let at300: { id: number; x: number; y: number; rx: number; ry: number }[] = [], ph300: number[] = [];
  for (let t = 0; t < 600; t++) {
    s.step(); rec.record(s);
    if (s.tick === 300) { at300 = s.vehicles.filter(v => !v.dead).map(v => { const p = s.pose(v); return { id: v.id, x: p.fx, y: p.fy, rx: p.rx, ry: p.ry }; }); ph300 = s.net.nodes.map((_, k) => s.nodeState(k).phase); }
  }
  const info = rec.info(), f = rec.frameAt(300, s)!;
  let worst = 0, worstRear = 0;
  at300.forEach((v, i) => { worst = Math.max(worst, Math.hypot(f.geo[i * 11] - v.x, f.geo[i * 11 + 1] - v.y)); worstRear = Math.max(worstRear, Math.hypot(f.geo[i * 11 + 2] - v.rx, f.geo[i * 11 + 3] - v.ry)); });
  const sameIds = at300.every((v, i) => f.ids[i] === v.id), samePhases = ph300.every((p, k) => f.phase[k] === p);
  const small = new Recorder(50_000); for (let t = 0; t < 50; t++) { s.step(); small.record(s); }
  const si = small.info();
  const ok = info.frames === 600 && info.from === 1 && info.to === 600 && f.tick === 300 && sameIds && samePhases && worst < 0.01 && worstRear < 0.06 && si.bytes <= 50_000 && si.frames < 50 && si.to === s.tick;
  console.log(`replay: ${info.frames} steps kept (${(info.bytes / 1024).toFixed(0)} kB), step 300 matches (front ${worst.toFixed(3)} m, rear ${worstRear.toFixed(2)} m, lights ${samePhases}); small budget keeps ${si.frames} newest | ok ${ok}`);
  if (!ok) process.exit(1);
}

// a side road that only turns right in and out touches one direction of the main road: the other
// direction drives straight through (never stops or asks), nothing overlaps; with the left turns back,
// every direction belongs to the junction again
{
  const J = makeNode(0, 0, "priority", false), W = makeNode(-300, 0), E = makeNode(300, 0), S = makeNode(0, 250);
  const wj = makeLink(W, J, 1, 1), je = makeLink(J, E, 1, 1), sj = makeLink(S, J, 1, 1, { signF: "yield" });
  const full = sanitizeNetwork({ version: 1, nodes: [J, W, E, S], stops: [], lines: [], links: [wj, je, sj] });
  const c0 = compile(full), n0 = c0.nodeById.get(J.id)!, before = throughConns(c0, n0).size;
  // switch the left turns off (into and out of the side road)
  const laneMap: Record<string, null[]> = {};
  for (const list of n0.moves.values()) for (const m of list) if (m.turn === "L") laneMap[`${m.in.key}>${m.out.key}`] = [null];
  const net = sanitizeNetwork({ ...full, nodes: full.nodes.map(n => (n.id === J.id ? { ...n, laneMap } : n)) });
  const c = compile(net), n = c.nodeById.get(J.id)!;
  // (conflict answers are kept per compile: the one before is done with)
  const thru = [...throughConns(c, n)], farS = thru.find(x => x.move.turn === "S"), far = farS?.inEdge;
  const sim = new Sim(c, { cars: 160, trucks: 0, seed: 4 });
  // requests the junction gets for a path driven through (there should be none)
  let overlap = 0, asks = 0, farThrough = 0;
  const S0 = sim as unknown as { arbitrate(st: { req: Map<number, { conn: unknown }> }): void };
  const arb = S0.arbitrate.bind(sim);
  S0.arbitrate = st => { for (const r of st.req.values()) if (thru.includes(r.conn as never)) asks++; arb(st); };
  const seen = new Set<number>();
  for (let t = 0; t < 4000; t++) {
    sim.step();
    const on = sim.vehicles.filter(v => !v.dead && v.piece.kind === "conn");
    for (const v of on) if (v.piece === farS && !seen.has(v.id)) { seen.add(v.id); farThrough++; }
    for (let i = 0; i < on.length; i++) for (let k = i + 1; k < on.length; k++) { const p = on[i].piece.poly.at(on[i].s), q = on[k].piece.poly.at(on[k].s); if (Math.hypot(p.x - q.x, p.y - q.y) < 2) overlap++; }
  }
  // the near side's straight on is joined by the right turn out of the side road: it stays part of the junction
  const nearS = [...n.moves.values()].flat().find(m => m.turn === "S" && m.in !== far);
  const ok = before === 0 && !!farS && far!.link.id !== sj.id && !(n.moves.get(far!.idx) ?? []).some(m => m.out.link.id === sj.id)
    && !!nearS && !thru.some(x => x.move === nearS) && asks === 0 && farThrough > 20 && overlap === 0 && sim.stats.towed === 0;
  console.log(`one-sided junction: ${before} through with left turns, ${thru.length} without (${thru.map(x => x.move.turn).join(", ")}); far side ${farThrough} vehicles through, ${asks} requests for those paths; ${sim.stats.trips} trips, ${overlap} overlaps, ${sim.stats.towed} towed | ok ${ok}`);
  if (!ok) process.exit(1);
}

// splitting a two-way road into two carriageways: the run goes straight on through the side-road
// junctions; each side road joins the carriageway on its own side (a junction on one direction only), no
// turning round where the road splits, traffic flows; with openings in a wide gap a side road still
// reaches the far direction
{
  const J = makeNode(0, 0, "priority", false), W = makeNode(-300, 0), E = makeNode(300, 0), Sg = makeNode(0, 250), K = makeNode(150, -10, "priority", false), Ng = makeNode(150, -250);
  const wj = makeLink(W, J, 2, 2), jk = makeLink(J, K, 2, 2), ke = makeLink(K, E, 2, 2), sj = makeLink(Sg, J, 1, 1, { signF: "yield" }), nk = makeLink(Ng, K, 1, 1, { signF: "yield" });
  const net = sanitizeNetwork({ version: 1, nodes: [J, W, E, Sg, K, Ng], stops: [], lines: [], links: [wj, jk, ke, sj, nk] });
  const run = carriagewayRun(net, jk.id);
  const runOk = !("error" in run) && run.links.length === 3 && run.nodes[0] === W.id && run.nodes[3] === E.id;
  const res = (gap: number, openings: boolean, cars: number) => {
    const r = splitCarriageways(net, run as Run, { gap, openings });
    if ("error" in r) throw new Error(r.error);
    const n2 = sanitizeNetwork({ ...r.net, flows: [{ id: "f", from: Sg.id, to: W.id, rate: 300 }] }), c = compile(n2);
    const fwd = new Set(r.forward), bwd = new Set(r.backward);
    // the side roads' new ends: S (south: right of eastbound traffic) on the eastbound carriageway, N on the westbound one
    const at = (l: string) => { const L = n2.links.find(x => x.id === l)!, node = L.to; return n2.links.filter(x => x.id !== l && (x.from === node || x.to === node)).map(x => x.id); };
    const on = (l: string, mine: Set<string>, other: Set<string>) => at(l).filter(x => mine.has(x)).length === 2 && !at(l).some(x => other.has(x));
    const sides = on(sj.id, fwd, bwd) && on(nk.id, bwd, fwd);
    const uTurns = c.nodes.filter(n => n.def.align).flatMap(n => [...n.moves.values()].flat()).filter(m => m.turn === "U").length;
    const sim = new Sim(c, { cars, trucks: 0, seed: 2 });
    let overlap = 0;
    for (let t = 0; t < 4000; t++) {
      sim.step();
      const on = sim.vehicles.filter(v => !v.dead && v.piece.kind === "conn");
      for (let i = 0; i < on.length; i++) for (let k = i + 1; k < on.length; k++) { const p = on[i].piece.poly.at(on[i].s), q = on[k].piece.poly.at(on[k].s); if (Math.hypot(p.x - q.x, p.y - q.y) < 2) overlap++; }
    }
    const f = sim.flowStats(0)!;
    const clusters = c.nodes.filter(n => n.cluster.length === 2 && n.cluster[0] === n).length;
    return { r, c, sides, uTurns, overlap, clusters, trips: sim.stats.trips, towed: sim.stats.towed, crossed: f.arrived, warnings: c.warnings.length };
  };
  const bwdSet = (r: { backward: string[] }) => new Set(r.backward);
  const plain = res(2, false, 120), open = res(2, true, 30);
  // the connectors across the gap removed again (as from the map): the two halves are separate junctions again
  let shut = sanitizeNetwork(open.r.net);
  for (const n of open.c.nodes) for (const ms of n.moves.values()) for (const m of ms) if (m.out.from !== n) for (let a = 0; a < m.in.n; a++) if (laneAllowed(m, a)) for (const b of exitLanesOf(m, a)) shut = sanitizeNetwork(changeConnection(shut, compile(shut), m.in.key, a, m.out.key, b, null));
  const shutOk = compile(shut).nodes.every(n => n.cluster.length === 1);
  // …and drawn by hand (as from the map): from the side road's lane to a lane of the other carriageway, offered as nearby
  const pc = compile(plain.r.net), sIn = pc.edgeByKey.get(`${sj.id}:1`)!;
  const far = lanesLeavingNear(pc, sIn, 0).find(x => x.e.from !== sIn.to && bwdSet(plain.r).has(x.e.link.id));
  const drawn = far ? connectLanes(plain.r.net, pc, sIn.key, 0, far.e.key, far.lp.lane) : null;
  const drawnOk = !!drawn && compile(sanitizeNetwork(drawn.net)).nodes.some(n => n.cluster.length === 2);
  const ok = drawnOk && shutOk && runOk && plain.r.junctions === 2 && plain.sides && plain.uTurns === 0 && plain.overlap === 0 && plain.towed === 0 && plain.trips > 200 && plain.warnings === 0 && plain.crossed === 0
    && open.sides && open.overlap === 0 && open.towed <= 1 && open.crossed > 5 && open.r.net.links.length === plain.r.net.links.length && open.clusters === 2 && plain.clusters === 0;
  console.log(`carriageways: run of ${"error" in run ? 0 : run.links.length} roads, ${plain.r.junctions} junctions split, side roads on their own side ${plain.sides}, U-turns at the splits ${plain.uTurns}; ${plain.trips} trips, ${plain.overlap} overlaps, ${plain.towed} towed; S→W left: ${plain.crossed} without openings, ${open.crossed} with (connectors across the gap: ${open.clusters} junctions over both carriageways; ${open.trips} trips, ${open.overlap} overlaps, ${open.towed} towed); removed again ${shutOk}, drawn by hand across the gap ${drawnOk} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// connectors written out: a plan whose junctions are all written out as they are compiles to the same turns
// and drives the same; a road added later gets automatic connectors, one left with none is closed; splitting,
// reversing and merging the roads at a written-out junction keeps its connectors
{
  const turns = (c: ReturnType<typeof compile>) => c.nodes.map(n => [...n.moves.values()].flat().map(m => `${m.in.key}>${m.out.key}:${m.turn}:${JSON.stringify(currentTargets(m))}`).sort().join(";")).join("\n");
  const drive = (c: ReturnType<typeof compile>) => { const s = new Sim(c, { cars: 250, trucks: 10, seed: 3 }); for (let t = 0; t < 1200; t++) s.step(); return s.vehicles.filter(v => !v.dead).map(v => `${v.id}:${v.s.toFixed(3)}`).join(",") + `|${s.stats.trips}`; };
  const same: string[] = [];
  for (const [name, raw] of [["claude-tests", JSON.parse(readFileSync("scripts/fixtures/claude-tests.json", "utf8")).network], ["osm-cluj", JSON.parse(readFileSync("scripts/fixtures/osm-cluj.json", "utf8"))]] as const) {
    const net = sanitizeNetwork(raw), c = compile(net, { outlines: false });
    let out: Network = net;
    for (const n of net.nodes) out = writeOut(out, c, n.id);
    const c2 = compile(sanitizeNetwork(out), { outlines: false }), written = out.nodes.filter(n => n.connectors).length;
    same.push(`${name}: ${written} written out, turns ${turns(c) === turns(c2)}, drives ${drive(c) === drive(c2)}`);
  }
  const conversionOk = same.every(x => !x.includes("false"));

  // a T junction written out, then a road added to it
  const J = makeNode(0, 0, "priority", false), W = makeNode(-200, 0), E = makeNode(200, 0), N = makeNode(0, -200);
  const wj = makeLink(W, J, 2, 2), je = makeLink(J, E, 2, 2);
  let net = sanitizeNetwork({ version: 1, nodes: [J, W, E, N], stops: [], lines: [], links: [wj, je] });
  net = writeOut(net, compile(net), J.id);
  const before = net.nodes.find(n => n.id === J.id)!.connectors!.length;
  const jn = makeLink(J, N, 1, 1);
  net = sanitizeNetwork({ ...net, links: [...net.links, jn] });
  let c = compile(net);
  const cn = c.nodeById.get(J.id)!;
  const fromN = (cc: typeof c) => (cc.nodeById.get(J.id)!.moves.get(cc.edgeByKey.get(`${jn.id}:-1`)!.idx) ?? []).length;
  const intoN = [...cn.moves.values()].flat().filter(m => m.out.link.id === jn.id).length;
  const added = fromN(c) === 2 && intoN === 2;
  // its connectors removed one by one: closed, nothing from it any more (and not automatic again)
  for (const m of cn.moves.get(c.edgeByKey.get(`${jn.id}:-1`)!.idx) ?? []) for (let a = 0; a < m.in.n; a++) if (laneAllowed(m, a)) for (const b of exitLanesOf(m, a)) { net = sanitizeNetwork(changeConnection(net, c, m.in.key, a, m.out.key, b, null)); c = compile(net); }
  const closedOk = fromN(c) === 0 && !!net.nodes.find(n => n.id === J.id)!.closed?.includes(`${jn.id}:-1`);
  // the roads around it changed: its connectors follow them
  const valid = (nw: Network) => { const cc = compile(nw), n = cc.nodeById.get(J.id)!; return n.def.connectors!.filter(x => cc.edgeByKey.get(x.in)?.to === n && cc.edgeByKey.get(x.out)?.from === n).length; };
  const sig = (nw: Network) => { const cc = compile(nw), n = cc.nodeById.get(J.id)!; return [...n.moves.values()].flat().map(m => `${m.turn}:${JSON.stringify(currentTargets(m))}`).sort().join(";"); };
  const ref = sig(net), all = net.nodes.find(n => n.id === J.id)!.connectors!.length;
  const [split, S] = splitLink(net, wj.id, 0.5, { x: W.x / 2, y: 0 });
  const rev = reverseLink(split, je.id);
  const pieces = rev.links.filter(l => l.from === S.id || l.to === S.id).map(l => l.id);
  const merged = mergeLinks(rev, pieces);
  const remapOk = valid(split) === all && sig(split) === ref && valid(rev) === all && sig(rev) === ref && !("error" in merged) && valid(merged.net) === all && sig(merged.net) === ref;
  const ok = conversionOk && before > 0 && added && closedOk && remapOk;
  console.log(`connectors written out: ${same.join("; ")} | road added later connected ${added}, emptied road closed ${closedOk}, kept through split / reverse / merge ${remapOk} | ok ${ok}`);
  if (!ok) process.exit(1);
}

// lights per connector: a junction's lights turned into connector phases as they are drive the same; a lane
// that goes straight on and left can have the left on its own arrow (it never goes in the straight phase, and
// the straight never in the arrow's); over a junction of two nodes (a divided road with openings) one node runs
// the lights of both
{
  const drive = (c: ReturnType<typeof compile>, steps = 1500) => { const s = new Sim(c, { cars: 160, trucks: 8, seed: 5 }); for (let t = 0; t < steps; t++) s.step(); return s.vehicles.filter(v => !v.dead).map(v => `${v.id}:${v.s.toFixed(3)}`).join(",") + `|${s.stats.trips}`; };
  const town = sampleTown(), tc = compile(town);
  const lightsNode = tc.nodes.find(n => n.def.control === "lights" && n.controlled && n.degree >= 4)!;
  const conv = sanitizeNetwork(toConnectorPhases(town, tc, lightsNode.def.id));
  const sameDrive = drive(tc) === drive(compile(conv));

  // a crossroads with one-lane approaches: W's lane goes left and straight on
  const J = makeNode(0, 0, "lights", false), W = makeNode(-250, 0), E = makeNode(250, 0), N = makeNode(0, -250), S = makeNode(0, 250);
  const links = [makeLink(W, J, 1, 1), makeLink(J, E, 1, 1), makeLink(N, J, 1, 1), makeLink(J, S, 1, 1)];
  let net = sanitizeNetwork({ version: 1, nodes: [J, W, E, N, S], stops: [], lines: [], links });
  let c = compile(net);
  net = sanitizeNetwork(toConnectorPhases(net, c, J.id));
  c = compile(net);
  const cn = c.nodeById.get(J.id)!, wIn = c.edgeByKey.get(`${links[0].id}:1`)!;
  const wMoves = cn.moves.get(wIn.idx)!, left = wMoves.find(m => m.turn === "L")!, straight = wMoves.find(m => m.turn === "S")!;
  const leftKey = connShapeKey(left, 0, exitLanesOf(left, 0)[0]);
  // the left out of every phase, into a third of its own
  for (let p = 0; p < net.nodes.find(n => n.id === J.id)!.phases!.length; p++) net = setConnGreen(net, J.id, p, leftKey, false);
  net = addPhase(net, J.id);
  net = sanitizeNetwork(setConnGreen(net, J.id, 2, leftKey, true));
  c = compile(net);
  const sim = new Sim(c, { cars: 120, trucks: 0, seed: 7 }), idx = c.nodeById.get(J.id)!.idx;
  const seen = new Set<number>(), phaseOf = { L: new Set<number>(), S: new Set<number>() };
  for (let t = 0; t < 6000; t++) {
    sim.step();
    for (const v of sim.vehicles) if (!v.dead && v.piece.kind === "conn" && v.piece.inEdge === c.edgeByKey.get(`${links[0].id}:1`) && !seen.has(v.id)) {
      seen.add(v.id);
      const st = sim.nodeState(idx), turn = (v.piece as { move: { turn: string } }).move.turn;
      if (turn === "L" || turn === "S") phaseOf[turn].add(st.phase);
    }
  }
  const arrowOk = phaseOf.L.size > 0 && phaseOf.S.size > 0 && [...phaseOf.L].every(p => p === 2) && !phaseOf.S.has(2) && straight !== undefined;

  // two nodes, one junction: a divided road with openings, its lights run from one of them
  const A = makeNode(0, 0, "priority", false), WW = makeNode(-300, 0), EE = makeNode(300, 0), SS = makeNode(0, 250);
  const wa = makeLink(WW, A, 2, 2), ae = makeLink(A, EE, 2, 2), sa = makeLink(SS, A, 1, 1);
  const base = sanitizeNetwork({ version: 1, nodes: [A, WW, EE, SS], stops: [], lines: [], links: [wa, ae, sa] });
  const run2 = carriagewayRun(base, wa.id) as Run, split = splitCarriageways(base, run2, { gap: 2, openings: true }) as { net: Network };
  let dn = sanitizeNetwork(split.net), dc = compile(dn);
  const half = dc.nodes.find(n => n.cluster.length === 2)!;
  dn = sanitizeNetwork(toConnectorPhases(dn, dc, half.def.id)); dc = compile(dn);
  const ctl = dc.nodeById.get(half.def.id)!, other = ctl.cluster.find(k => k !== ctl)!;
  const sim2 = new Sim(dc, { cars: 80, trucks: 0, seed: 3 });
  let overlap = 0, follows = true;
  for (let t = 0; t < 4000; t++) {
    sim2.step();
    const a = sim2.nodeState(ctl.idx), b = sim2.nodeState(other.idx);
    if (a.phase !== b.phase || a.stage !== b.stage) follows = false;
    const on = sim2.vehicles.filter(v => !v.dead && v.piece.kind === "conn");
    for (let i = 0; i < on.length; i++) for (let k = i + 1; k < on.length; k++) { const p = on[i].piece.poly.at(on[i].s), q = on[k].piece.poly.at(on[k].s); if (Math.hypot(p.x - q.x, p.y - q.y) < 2) overlap++; }
  }
  const sharedOk = other.signals === ctl && follows && overlap === 0 && sim2.stats.towed <= 1 && sim2.stats.trips > 50;
  const ok = sameDrive && arrowOk && sharedOk;
  console.log(`lights per connector: converted as they are drive the same ${sameDrive}; protected left from a shared lane: left in phases ${[...phaseOf.L].map(p => p + 1)}, straight in ${[...phaseOf.S].map(p => p + 1)}; two nodes one junction: lights follow ${follows}, ${sim2.stats.trips} trips, ${overlap} overlaps, ${sim2.stats.towed} towed | ok ${ok}`);
  if (!ok) process.exit(1);
}

// two roads that don't meet, their loose ends 10 m apart: a connector from one's lane end to the other's
// lane start makes them one road through a junction (the loose ends are no longer entry points)
{
  const W = makeNode(-200, 0), X = makeNode(0, 0), Y = makeNode(10, 2), E = makeNode(210, 2);
  const a = makeLink(W, X, 1, 1), b = makeLink(Y, E, 1, 1);
  let net = sanitizeNetwork({ version: 1, nodes: [W, X, Y, E], stops: [], lines: [], links: [a, b], flows: [{ id: "f", from: W.id, to: E.id, rate: 400 }] });
  let c = compile(net);
  const ein = c.edgeByKey.get(`${a.id}:1`)!, offered = lanesLeavingNear(c, ein, 0).some(x => x.e.key === `${b.id}:1`);
  const r = connectLanes(net, c, ein.key, 0, `${b.id}:1`, 0)!;
  net = sanitizeNetwork(r.net); c = compile(net);
  const x = c.nodeById.get(X.id)!, y = c.nodeById.get(Y.id)!;
  const joined = x.cluster.includes(y) && !x.gateway && !y.gateway && x.controlled;
  const sim = new Sim(c, { cars: 0, trucks: 0, seed: 3 });
  for (let t = 0; t < 3000; t++) sim.step();
  const f = sim.flowStats(0)!;
  const ok = offered && joined && f.arrived > 10 && sim.stats.towed === 0;
  console.log(`connector between loose road ends: offered ${offered}, one junction ${joined}, ${f.arrived} of ${f.sent} arrived across it, ${sim.stats.towed} towed | ok ${ok}`);
  if (!ok) process.exit(1);
}

// aggressive drivers: a share of cars wants to go over the limit, by up to the set excess; the others never do
{
  const W = makeNode(-600, 0), E = makeNode(600, 0);
  const net = sanitizeNetwork({ version: 1, nodes: [W, E], stops: [], lines: [], links: [makeLink(W, E, 2, 2, { speed: 50 })] });
  const sim = new Sim(compile(net), { cars: 40, trucks: 0, seed: 3, params: { aggressiveShare: 30, aggressiveExcess: 25 } });
  const top = new Map<number, { v: number; aggr: boolean }>();
  for (let t = 0; t < 3000; t++) {
    sim.step();
    for (const v of sim.vehicles) if (!v.dead && v.kind === "car") { const x = top.get(v.id); if (!x || v.v > x.v) top.set(v.id, { v: v.v, aggr: v.aggressive }); }
  }
  const lim = 50 / 3.6, all = [...top.values()], aggr = all.filter(x => x.aggr), calm = all.filter(x => !x.aggr);
  const share = aggr.length / Math.max(1, all.length), fastest = Math.max(...aggr.map(x => x.v)) * 3.6, calmTop = Math.max(...calm.map(x => x.v)) * 3.6;
  const ok = share > 0.15 && share < 0.45 && aggr.some(x => x.v > lim * 1.05) && fastest <= 50 * 1.25 + 0.5 && calmTop <= 50.05;
  // and none at all by default (the run as before)
  const plain = new Sim(compile(net), { cars: 40, trucks: 0, seed: 3 });
  for (let t = 0; t < 200; t++) plain.step();
  const none = plain.vehicles.every(v => !v.aggressive);
  console.log(`aggressive drivers: ${aggr.length} of ${all.length} cars (${(share * 100).toFixed(0)}% for 30%), fastest ${fastest.toFixed(1)} km/h on a 50 limit (up to ${(50 * 1.25).toFixed(1)}), others at most ${calmTop.toFixed(1)}; none by default ${none} | ok ${ok && none}`);
  if (!(ok && none)) process.exit(1);
}
