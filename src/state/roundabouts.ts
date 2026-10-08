/**
 * The Roundabout tool: a roundabout built from a centre and its outer kerb's radius, as a ring of one-way
 * roads circulating anticlockwise (on the map), each road arriving joining it at a priority junction where it
 * gives way to the ring. Everything is then ordinary roads and junctions, edited like any other: the ring's
 * lanes and curves, each entry's and exit's lane connectors, signs, lane arrows.
 *
 * Roads crossing the circle where the approaches start are cut there and what is inside goes; road ends on
 * it, or just outside, join. Each carries on along a short approach that turns from its own heading to meet
 * the ring square on. Roads arriving close together (a dual carriageway's two halves) are spread apart a little.
 */
import { LW } from "@/engine/compile";
import { makeNode, newId } from "@/engine/sample";
import { RING_MAX, RING_MIN, type LinkDef, type Network, type NodeDef, type Vec } from "@/engine/types";
import { boxAround, crossing, junctionOf, linkNear } from "./junctions";
import { makeGroup } from "./groups";
import * as ops from "./ops";

/** how far outside the kerb the roads are cut and the approaches start (m) */
const APPROACH = 18;
/** a road's loose end this close outside the circle (m) is moved onto it and joins */
const SNAP = 6;
/** the ring's junctions are at least this far apart along it (m); on a small ring, down to MIN_SEG_SMALL */
const MIN_SEG = 16, MIN_SEG_SMALL = 9;
/** the shortest approach from a road's end to the ring (m) */
const MIN_APPROACH = 6;
/** the ring is split where its arms are further apart than this (rad): a road can't bend round more */
const MAX_ARC = (2 * Math.PI) / 3;
/** the ring's speed limit (km/h) */
const RING_SPEED = 30;
/** a kerb radius this big or more gets two circulating lanes to start with (m) */
export const TWO_LANES_FROM = 20;

const clampKerb = (kerb: number) => Math.max(RING_MIN, Math.min(RING_MAX, kerb));
/** the ring road's centre line, for a kerb radius and its lanes */
const ringRadius = (kerb: number, lanes: 1 | 2) => clampKerb(kerb) - (lanes * LW) / 2;
/** how far from the centre the roads are cut and the approaches start */
export const joinRadius = (kerb: number) => clampKerb(kerb) + APPROACH;
/** the central island's radius (for the preview): the ring's inner edge */
export const islandRadius = (kerb: number, lanes: 1 | 2) => clampKerb(kerb) - lanes * LW;

const degree = (net: Network, id: string) => net.links.reduce((k, l) => k + (l.from === id ? 1 : 0) + (l.to === id ? 1 : 0), 0);
const unit = (v: Vec): Vec => { const d = Math.hypot(v.x, v.y) || 1; return { x: v.x / d, y: v.y / d }; };
const TAU = 2 * Math.PI;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

/** the heading of a road at one of its ends, pointing into the road away from that end */
function headingFrom(l: LinkDef, A: Vec, B: Vec, atFrom: boolean): Vec {
  const near = (p: Vec | null, q: Vec) => !p || Math.hypot(p.x - q.x, p.y - q.y) < 0.05;
  if (atFrom) return unit(near(l.c1, A) ? { x: (l.c2 ?? B).x - A.x, y: (l.c2 ?? B).y - A.y } : { x: l.c1!.x - A.x, y: l.c1!.y - A.y });
  return unit(near(l.c2, B) ? { x: (l.c1 ?? A).x - B.x, y: (l.c1 ?? A).y - B.y } : { x: l.c2!.x - B.x, y: l.c2!.y - B.y });
}

/**
 * A roundabout centred on `c` whose outer kerb has radius `kerb` (m), with one or two circulating lanes.
 * Needs three roads or more reaching the circle (crossing it, or ending on it or up to SNAP m outside).
 * Returns the plan and the ring's first road.
 */
export function createRoundabout(net: Network, c: Vec, kerb: number, lanes: 1 | 2, opts: { ends?: string[] } = {}): { net: Network; ring: string; group: string } | { error: string } {
  kerb = clampKerb(kerb);
  // (inside a junction drawn by hand: its road ends, wherever they are, each joining the ring)
  if (opts.ends) return ringFor(net, c, kerb, lanes, opts.ends.map(id => { const n = ops.nodeById(net, id)!; return { id, angle: wrap(Math.atan2(n.y - c.y, n.x - c.x)) }; }));
  const R = joinRadius(kerb), circle: Vec[] = [];
  for (let k = 0; k < 128; k++) circle.push({ x: c.x + R * Math.cos((k / 128) * TAU), y: c.y + R * Math.sin((k / 128) * TAU) });
  // cut the roads where they cross the circle (only those near it are looked at)
  const box = boxAround(circle, SNAP + 1);
  for (let guard = 0; guard < 1000; guard++) {
    const hit = net.links.filter(l => linkNear(net, l, box)).map(l => ({ l, t: crossing(net, l.id, circle) })).find(x => x.t !== null);
    if (!hit) break;
    const A = ops.nodeById(net, hit.l.from)!, B = ops.nodeById(net, hit.l.to)!;
    [net] = ops.splitLink(net, hit.l.id, hit.t!, ops.linkPoint(hit.l, A, B, hit.t!));
  }
  // what is inside goes (roads, and the points left without one)
  for (const l of net.links.filter(x => linkNear(net, x, box))) {
    const A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!, mid = ops.linkPoint(l, A, B, 0.5);
    if (Math.hypot(mid.x - c.x, mid.y - c.y) < R - 0.05) net = ops.deleteLink(net, l.id);
  }
  // road ends on the circle, or just outside it (moved onto it): not those on a junction drawn by hand
  const ends: { id: string; angle: number }[] = [];
  for (const n of [...net.nodes]) {
    const d = Math.hypot(n.x - c.x, n.y - c.y);
    if (degree(net, n.id) !== 1 || junctionOf(net, n.id) || d < R - 0.6 || d > R + SNAP) continue;
    if (Math.abs(d - R) > 0.05) net = ops.moveNode(net, n.id, { x: ops.round(c.x + ((n.x - c.x) / d) * R), y: ops.round(c.y + ((n.y - c.y) / d) * R) });
    ends.push({ id: n.id, angle: wrap(Math.atan2(n.y - c.y, n.x - c.x)) });
  }
  if (ends.length < 3) {
    return { error: `${ends.length ? `Only ${ends.length} road${ends.length === 1 ? "" : "s"} reach` : "No road reaches"} the circle: a roundabout needs three or more. Draw it across the roads, or around their ends (up to ${SNAP} m away).` };
  }
  return ringFor(net, c, kerb, lanes, ends);
}

/** the ring and its junctions for these road ends (angles round the centre) */
function ringFor(net: Network, c: Vec, kerb: number, lanes: 1 | 2, ends: { id: string; angle: number }[]): { net: Network; ring: string; group: string } | { error: string } {
  const Rc = ringRadius(kerb, lanes);
  if (ends.length < 2) return { error: "At least two roads must reach it." };
  // each road end at least a short approach outside the ring: one too close is cut back along its road
  const need = Rc + (lanes * LW) / 2 + MIN_APPROACH;
  for (const e of ends) {
    const n = ops.nodeById(net, e.id)!;
    if (Math.hypot(n.x - c.x, n.y - c.y) >= need) continue;
    const l = net.links.find(x => x.from === e.id || x.to === e.id)!, A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!;
    // (from its end along it, the first point far enough out)
    let t = -1;
    for (let k = 1; k <= 200; k++) { const u = l.to === e.id ? 1 - k / 200 : k / 200, q = ops.linkPoint(l, A, B, u); if (Math.hypot(q.x - c.x, q.y - c.y) >= need) { t = u; break; } }
    if (t < 0 || (l.to === e.id ? t < 0.05 : t > 0.95)) return { error: "A road of the junction is too short for the ring: make the ring smaller, or move its centre." };
    const [cut, P] = ops.splitLink(net, l.id, t, ops.linkPoint(l, A, B, t));
    const piece = cut.links.find(x => (x.from === e.id && x.to === P.id) || (x.from === P.id && x.to === e.id))!;
    net = { ...cut, links: cut.links.filter(x => x.id !== piece.id), nodes: cut.nodes.filter(x => x.id !== e.id) };
    e.id = P.id; e.angle = wrap(Math.atan2(P.y - c.y, P.x - c.x));
  }

  // the junctions round the ring, one per road, spaced at least MIN_SEG apart along it (roads arriving close
  // together, like a dual carriageway's two halves, are spread apart a little)
  ends.sort((a, b) => a.angle - b.angle);
  // (on a small ring the entries may be closer: down to what still leaves room between them)
  const seg = Math.min(MIN_SEG, (0.85 * TAU * Rc) / ends.length), gap = seg / Rc;
  if (seg < MIN_SEG_SMALL) return { error: `The ring is too small for ${ends.length} roads: make it bigger.` };
  const angles = ends.map(e => e.angle);
  for (let it = 0; it < 200; it++) {
    let moved = false;
    for (let i = 0; i < angles.length; i++) {
      const j = (i + 1) % angles.length, d = wrap(angles[j] - angles[i]) || (angles.length === 1 ? TAU : 0);
      if (d < gap - 1e-6) { const push = (gap - d) / 2 + 1e-4; angles[i] -= push; angles[j] += push; moved = true; }
    }
    if (!moved) break;
  }
  const groups = ends.map((e, i) => ({ ends: [e], angle: wrap(angles[i]) }));
  const at = (a: number): Vec => ({ x: ops.round(c.x + Rc * Math.cos(a)), y: ops.round(c.y + Rc * Math.sin(a)) });
  const nodes: NodeDef[] = [], links: LinkDef[] = [];
  const point = (a: number) => { const p = at(a), n: NodeDef = { ...makeNode(p.x, p.y, "priority", false) }; nodes.push(n); return n; };
  // the ring's points: a junction for each group, and plain points between groups far apart
  const ring: { node: NodeDef; angle: number; group: (typeof groups)[number] | null }[] = [];
  groups.sort((a, b) => a.angle - b.angle);
  groups.forEach((g, i) => {
    ring.push({ node: point(g.angle), angle: g.angle, group: g });
    const next = i + 1 < groups.length ? groups[i + 1].angle : groups[0].angle + TAU, gap = next - g.angle, parts = Math.ceil(gap / MAX_ARC);
    for (let k = 1; k < parts; k++) { const a = g.angle + (gap * k) / parts; ring.push({ node: point(wrap(a)), angle: a, group: null }); }
  });
  // the ring: one-way roads from each point to the one before it (anticlockwise on the map: decreasing angle)
  const ringIds: string[] = [], tag = newId("rb");
  for (let i = 0; i < ring.length; i++) {
    const from = ring[i], to = ring[(i - 1 + ring.length) % ring.length];
    const a = from.angle, d = wrap(a - to.angle) || TAU, b = a - d, h = (4 / 3) * Math.tan(d / 4) * Rc;
    const pa = at(a), pb = at(b);
    const link: LinkDef = {
      id: newId("l"), name: "", from: from.node.id, to: to.node.id, lanesF: lanes, lanesB: 0, busF: false, busB: false, speed: RING_SPEED, ring: tag,
      c1: { x: ops.round(pa.x + h * Math.sin(a)), y: ops.round(pa.y - h * Math.cos(a)) },
      c2: { x: ops.round(pb.x - h * Math.sin(b)), y: ops.round(pb.y + h * Math.cos(b)) },
    };
    links.push(link);
    ringIds.push(link.id);
  }
  // round the ring each lane carries on in the same lane through the junctions (lanes change between them)
  if (lanes > 1) for (const { node } of ring) {
    const into = links.find(l => l.ring === tag && l.to === node.id)!, out = links.find(l => l.ring === tag && l.from === node.id)!;
    node.laneMap = { [`${into.id}:1>${out.id}:1`]: Array.from({ length: lanes }, (_, a) => a) };
  }
  // the approaches: from where each road was cut to its junction on the ring, giving way there
  for (const { node: Q, group } of ring) for (const end of group?.ends ?? []) {
    const id = end.id, P = ops.nodeById(net, id)!, l = net.links.find(x => x.from === id || x.to === id)!;
    const A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!, len = Math.hypot(Q.x - P.x, Q.y - P.y);
    // the road's heading at P, toward the ring; the approach turns from it to meet the ring square on
    const away = headingFrom(l, A, B, l.from === id), into = { x: -away.x, y: -away.y }, radial = unit({ x: c.x - Q.x, y: c.y - Q.y });
    const nearP = { x: ops.round(P.x + into.x * len * 0.4), y: ops.round(P.y + into.y * len * 0.4) }, nearQ = { x: ops.round(Q.x - radial.x * len * 0.4), y: ops.round(Q.y - radial.y * len * 0.4) };
    // (the same lanes as the road, travelling the same way; the way in gives way to the ring)
    const toRing = l.to === id;
    links.push({
      ...l, id: newId("l"), from: toRing ? id : Q.id, to: toRing ? Q.id : id, c1: toRing ? nearP : nearQ, c2: toRing ? nearQ : nearP,
      turnsF: null, turnsB: null, splitF: null, splitB: null, greenF: null, greenB: null,
      baysF: null, baysB: null, dropF: null, dropB: null, counter: undefined, slip: null, rev: undefined,
      signF: toRing && l.lanesF > 0 ? "yield" : null, signB: !toRing && l.lanesB > 0 ? "yield" : null,
    });
    net = ops.updateNode(net, id, { gateway: false, junction: undefined, connectors: undefined, closed: undefined, laneMap: undefined, connShape: undefined, align: undefined, inflow: undefined, exitWeight: undefined });
  }
  // (kept together as one junction: moved, copied and saved as one; double-click to edit inside)
  const [grouped, g] = makeGroup({ ...net, nodes: [...net.nodes, ...nodes], links: [...net.links, ...links] }, links.map(l => l.id), `Roundabout ${Math.round(kerb)} m`);
  return { net: grouped, ring: ringIds[0], group: g!.id };
}
