/**
 * The roundabout stamp: a ring of lane round a centre, joined to the lanes that end or start just outside
 * it, in one go — and then nothing but ordinary pieces of the sketch. No roundabout is kept: the ring is a
 * lane, the ways on and off are connectors, the ways in get a yield sign, the surface is an automatic
 * junction; each is edited as any other, and one undo takes the whole stamp back.
 *
 * Ways in: lanes (not rings) ending within `reach` metres outside the ring, heading in; each joins the ring
 * a little after where it meets it. Ways out: lanes starting there, heading out; each leaves the ring a
 * little before. The connectors that went straight from a way in to a way out (the junction it replaces)
 * go, and so does a junction surface over the middle. Traffic goes round anticlockwise, as the Ring tool's.
 * Framework-free.
 */
import { dist, LANE_WIDTH, laneLength, nextId, nearestOn, pointAt, remove, sliceLane, type Pt, type Sketch, type SketchConnector, type SketchLane } from "./lane-sketch";

export interface RoundaboutReport { ins: number; outs: number; removedConnectors: number; removedJunctions: number; /** lanes ending or starting inside the ring, left as they were */ inside: string[]; /** lanes running across where the ring goes: cut where they meet it, the stretch inside taken out, the two ends joined to it */ crossed: string[] }

const TAU = 2 * Math.PI;
/** metres along the ring after where a way in meets it (and before where a way out leaves) */
const JOIN_AFTER = 7;
/** how far outside the ring's edge a lane running across it is cut (metres) */
const CUT_GAP = 3;

export function stampRoundabout(sk: Sketch, c: Pt, r: number, reach = 30): { sketch: Sketch; report: RoundaboutReport; ring: string; junction: string } {
  const R = Math.max(4, r), outer = R + LANE_WIDTH / 2;
  const ends = (l: SketchLane) => { const L = laneLength(l.shape); return { a: pointAt(l.shape, 0), b: pointAt(l.shape, L) }; };
  // lanes running across where the ring goes (both ends outside it): cut CUT_GAP outside its edge on either side, the
  // stretch between taken out (with its connectors); the stretch coming in a way in, the one going on a way out
  const crossed: string[] = [], forceIn = new Set<string>(), forceOut = new Set<string>();
  for (const l of sk.lanes) {
    if ((l.shape.kind === "line" && l.shape.closed) || (l.shape.kind === "arc" && Math.abs(l.shape.sweep) >= TAU - 1e-6)) continue;
    const L = laneLength(l.shape), { a, b } = ends(l), near = nearestOn(l.shape, c), edge = outer + CUT_GAP;
    if (near.d > outer || dist(a.p, c) <= edge || dist(b.p, c) <= edge) continue;
    let s0 = near.s, s1 = near.s;
    while (s0 > 0 && dist(pointAt(l.shape, s0).p, c) < edge) s0 -= 0.25;
    while (s1 < L && dist(pointAt(l.shape, s1).p, c) < edge) s1 += 0.25;
    if (s0 <= 0.5 || s1 >= L - 0.5) continue;
    const ids = sk.lanes.map(x => x.id), after = nextId("l", ids), mid = nextId("l", [...ids, after]);
    const cut = sliceLane(sk, l.id, s1, after), cut2 = cut && sliceLane(cut, l.id, s0, mid);
    if (!cut2) continue;
    sk = remove(cut2, { lanes: [mid] });
    crossed.push(l.id); forceIn.add(l.id); forceOut.add(after);
  }
  const ins: SketchLane[] = [], outs: SketchLane[] = [], inside: string[] = [];
  for (const l of sk.lanes) {
    if (forceIn.has(l.id)) { ins.push(l); continue; }
    if (forceOut.has(l.id)) { outs.push(l); continue; }
    if (l.shape.kind === "line" && l.shape.closed) continue;
    if (l.shape.kind === "arc" && Math.abs(l.shape.sweep) >= TAU - 1e-6) continue;
    const { a, b } = ends(l);
    const db = dist(b.p, c), da = dist(a.p, c);
    // (heading in at its end / out at its start)
    const inward = (b.d.x * (c.x - b.p.x) + b.d.y * (c.y - b.p.y)) / Math.max(1e-6, db) > 0.3;
    const outward = (a.d.x * (a.p.x - c.x) + a.d.y * (a.p.y - c.y)) / Math.max(1e-6, da) > 0.3;
    if (inward && db <= outer + reach) { if (db <= outer + 0.5) inside.push(l.id); else ins.push(l); }
    else if (outward && da <= outer + reach) { if (da <= outer + 0.5) inside.push(l.id); else outs.push(l); }
  }
  // (not a lane already leading somewhere else at that end — to the next junction, say — only one leading across to another of
  // the ways in or out, the junction the ring replaces)
  {
    const inSet = new Set(ins.map(l => l.id)), outSet = new Set(outs.map(l => l.id));
    const endOf = new Map(sk.lanes.map(l => [l.id, laneLength(l.shape)]));
    const elsewhereIn = (id: string) => !forceIn.has(id) && sk.connectors.some(k => k.from.lane === id && k.from.s >= (endOf.get(id) ?? 0) - 1 && !outSet.has(k.to.lane));
    const elsewhereOut = (id: string) => !forceOut.has(id) && sk.connectors.some(k => k.to.lane === id && k.to.s <= 1 && !inSet.has(k.from.lane));
    for (let i = ins.length - 1; i >= 0; i--) if (elsewhereIn(ins[i].id)) ins.splice(i, 1);
    for (let i = outs.length - 1; i >= 0; i--) if (elsewhereOut(outs[i].id)) outs.splice(i, 1);
  }
  // the ring: anticlockwise, starting east
  const ringId = nextId("l", sk.lanes.map(l => l.id));
  const ring: SketchLane = { id: ringId, shape: { kind: "arc", c: { x: round(c.x), y: round(c.y) }, r: round(R), a0: 0, sweep: -TAU }, width: LANE_WIDTH };
  const L = TAU * R, at = (p: Pt) => nearestOn(ring.shape, p).s, wrap = (s: number) => ((s % L) + L) % L;
  // what it replaces: connectors straight from a way in to a way out, and a junction over the middle
  const inIds = new Set(ins.map(l => l.id)), outIds = new Set(outs.map(l => l.id));
  const old = sk.connectors.filter(x => inIds.has(x.from.lane) && outIds.has(x.to.lane)).map(x => x.id);
  const oldJ = sk.junctions.filter(j => { const m = centroid(j.outline); return dist(m, c) <= outer + 2; }).map(j => j.id);
  let out = remove(sk, { connectors: old, junctions: oldJ });
  out = { ...out, lanes: [...out.lanes.map(l => (inIds.has(l.id) ? { ...l, control: "yield" as const } : l)), ring] };
  // on and off
  const ids = out.connectors.map(x => x.id), conns: SketchConnector[] = [];
  const fresh = () => { const id = nextId("c", ids); ids.push(id); return id; };
  for (const l of ins) { const L0 = laneLength(l.shape), p = pointAt(l.shape, L0).p; conns.push({ id: fresh(), from: { lane: l.id, s: round(L0) }, to: { lane: ringId, s: round(wrap(at(p) + JOIN_AFTER)) } }); }
  for (const l of outs) { const p = pointAt(l.shape, 0).p; conns.push({ id: fresh(), from: { lane: ringId, s: round(wrap(at(p) - JOIN_AFTER)) }, to: { lane: l.id, s: 0 } }); }
  out = { ...out, connectors: [...out.connectors, ...conns] };
  // the surface: an automatic junction over the ring and the ways on and off (the island left)
  const jId = nextId("j", out.junctions.map(j => j.id)), jr = outer + 6;
  const outline = Array.from({ length: 24 }, (_, i) => ({ x: round(c.x + jr * Math.cos((i / 24) * TAU)), y: round(c.y + jr * Math.sin((i / 24) * TAU)) }));
  const n = out.junctions.filter(j => j.name.startsWith("Roundabout")).length + 1;
  out = { ...out, junctions: [...out.junctions, { id: jId, name: `Roundabout ${n}`, outline, shape: "auto" }] };
  return { sketch: out, report: { ins: ins.length, outs: outs.length, removedConnectors: old.length, removedJunctions: oldJ.length, inside, crossed }, ring: ringId, junction: jId };
}

const round = (x: number) => Math.round(x * 100) / 100;
const centroid = (pts: Pt[]) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });
