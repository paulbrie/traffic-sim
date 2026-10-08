/**
 * Splitter islands: the last stretch of a two-way road before a junction parted into its two directions, as two
 * one-way roads fanning out to the junction with a kerbed triangular island between them (as at a roundabout's
 * entries). Where they part, the point lines the lanes up (NodeDef.align); at the junction the road's lane
 * connectors, lane maps and lights carry over to the two new roads.
 */
import { newId } from "@/engine/sample";
import type { LinkDef, Network, NodeDef, Vec } from "@/engine/types";
import { junctionOf } from "./junctions";
import * as ops from "./ops";
import { laneWidth } from "@/engine/compile";

export const ISLAND_LEN = 20, ISLAND_WIDTH = 4;

/**
 * Part the end of road `linkId` at point `at` (one of its ends, at a junction) over its last `len` m, the two
 * directions `width` m apart at the junction. Returns the plan, or why not.
 */
export function splitterIsland(net: Network, linkId: string, at: string, len = ISLAND_LEN, width = ISLAND_WIDTH): { net: Network; island: string } | { error: string } {
  const l0 = ops.linkById(net, linkId);
  if (!l0 || (l0.from !== at && l0.to !== at)) return { error: "Pick an end of the road." };
  if (!l0.lanesF || !l0.lanesB) return { error: "Only a two-way road can part around an island." };
  const A0 = ops.nodeById(net, l0.from)!, B0 = ops.nodeById(net, l0.to)!, L = ops.linkLength(l0, A0, B0);
  if (L < len + 5) return { error: `The road is too short (${L.toFixed(0)} m) for a ${len} m island: make it shorter, or the road longer.` };
  // cut it `len` m from the end; P is the piece reaching the junction
  const t = l0.to === at ? ops.tAtLength(l0, A0, B0, L - len) : ops.tAtLength(l0, A0, B0, len);
  // (at a junction point, both ways would meet again at it: there is no room for an island)
  if (net.links.filter(x => x.from === at || x.to === at).length > 1) return { error: "The road must end on its own here: at a junction drawn by hand (its border), or at an entry / exit point." };
  const [cut, S] = ops.splitLink(net, linkId, t, ops.linkPoint(l0, A0, B0, t));
  net = cut;
  const P = net.links.find(x => (x.from === S.id && x.to === at) || (x.from === at && x.to === S.id))!;
  const J = ops.nodeById(net, at)!, Sn = ops.nodeById(net, S.id)!;
  // P as it runs from S to the junction: its lanes that way, the other way, and its heading at the junction
  const toJ = P.from === S.id, lanesIn = toJ ? P.lanesF : P.lanesB, lanesOut = toJ ? P.lanesB : P.lanesF;
  const busIn = toJ ? P.busF : P.busB, busOut = toJ ? P.busB : P.busF;
  const dx = J.x - Sn.x, dy = J.y - Sn.y, d = Math.hypot(dx, dy) || 1, R = { x: -dy / d, y: dx / d };
  // (traffic keeps right: the way in on the right of the way there, the way out on the left; each road's centre
  // line half its own lanes plus half the island out from the old one)
  const hand = junctionOf(net, J.id), lw = laneWidth(P), offIn = (lanesIn * lw) / 2 + width / 2, offOut = (lanesOut * lw) / 2 + width / 2;
  const shift = (s: number): Vec => ({ x: ops.round(J.x + R.x * s), y: ops.round(J.y + R.y * s) });
  const strip = (x: LinkDef): LinkDef => ({
    ...x, turnsF: null, turnsB: null, signF: null, signB: null, splitF: null, splitB: null, greenF: null, greenB: null, baysF: null, baysB: null, dropF: null, dropB: null,
    median: undefined, medianKind: undefined, c1: null, c2: null, counter: undefined, slip: null, rev: undefined,
  });
  // the old end goes: two ends side by side, the way in taking its place (and what it held for the junction)
  let jIn: NodeDef = { ...J, id: newId("n"), ...shift(offIn) };
  const jOut: NodeDef = { ...J, id: newId("n"), ...shift(-offOut), connectors: undefined, closed: undefined, outline: undefined, paint: undefined, phases: null, laneMap: undefined, connShape: undefined };
  if (hand?.nodes[0] === J.id && J.outline) {
    // (the junction's leading end: its outline and painted areas are relative to it)
    const mv = (p: Vec) => ({ x: ops.round(p.x + J.x - jIn.x), y: ops.round(p.y + J.y - jIn.y) });
    jIn = { ...jIn, outline: J.outline.map(p => ({ ...p, ...mv(p) })), paint: J.paint?.map(a => ({ ...a, pts: a.pts.map(mv) })) };
  }
  const way = toJ ? 1 : -1, inId = newId("l"), outId = newId("l");
  const roadIn: LinkDef = { ...strip(P), id: inId, from: S.id, to: jIn.id, lanesF: lanesIn, lanesB: 0, busF: busIn, busB: false,
    turnsF: (toJ ? P.turnsF : P.turnsB) ?? null, signF: (toJ ? P.signF : P.signB) ?? null, greenF: (toJ ? P.greenF : P.greenB) ?? null, baysF: (toJ ? P.baysF : P.baysB) ?? null };
  const roadOut: LinkDef = { ...strip(P), id: outId, from: jOut.id, to: S.id, lanesF: lanesOut, lanesB: 0, busF: busOut, busB: false };
  net = { ...net, nodes: [...net.nodes.filter(n => n.id !== J.id), jIn, jOut], links: [...net.links.filter(x => x.id !== P.id), roadIn, roadOut] };
  // the road's keys at the junction, now the new roads': in (arriving there) and out (leaving)
  if (hand) {
    const keyIn = `${P.id}:${way}`, keyOut = `${P.id}:${-way}`;
    const remap = (k: string) => (k === keyIn ? `${inId}:1` : k === keyOut ? `${outId}:1` : k);
    net = { ...net, junctions: net.junctions!.map(j => (j.id === hand.id ? { ...j, nodes: j.nodes.flatMap(id => (id === J.id ? [jIn.id, jOut.id] : [id])) } : j)) };
    for (const id of [...hand.nodes.filter(x => x !== J.id), jIn.id, jOut.id]) net = ops.remapEdgeKeys(net, id, remap);
  }
  // where they part: lanes lined up; the island between them, kerbed (a little short of the junction's edge)
  const ux = dx / d, uy = dy / d, tip = { x: Sn.x + ux * 3, y: Sn.y + uy * 3 };
  const wide = Math.max(0.5, width - 1.2), end = { x: J.x - ux * 1.2, y: J.y - uy * 1.2 };
  const pts = [tip, { x: end.x + R.x * (wide / 2), y: end.y + R.y * (wide / 2) }, { x: end.x - R.x * (wide / 2), y: end.y - R.y * (wide / 2) }].map(p => ({ x: ops.round(p.x - Sn.x), y: ops.round(p.y - Sn.y) }));
  net = ops.updateNode(net, S.id, { align: true, gateway: false, paint: [...(Sn.paint ?? []), { kind: "island", pts }] });
  return { net, island: S.id };
}

/** the splitter island held by point `id` (where a road parts round it): its roads, or null if it isn't one */
export function islandAt(net: Network, id: string) {
  const S = ops.nodeById(net, id);
  if (!S?.align || !S.paint?.some(a => a.kind === "island")) return null;
  const at = net.links.filter(l => l.from === id || l.to === id);
  if (at.length !== 3) return null;
  const road = at.find(l => l.lanesF > 0 && l.lanesB > 0), roadIn = at.find(l => l.from === id && l.lanesB === 0), roadOut = at.find(l => l.to === id && l.lanesB === 0);
  if (!road || !roadIn || !roadOut) return null;
  const jIn = ops.nodeById(net, roadIn.to)!, jOut = ops.nodeById(net, roadOut.from)!;
  const deg = (n: string) => net.links.filter(l => l.from === n || l.to === n).length;
  if (deg(jIn.id) !== 1 || deg(jOut.id) !== 1) return null;
  const len = Math.hypot((jIn.x + jOut.x) / 2 - S.x, (jIn.y + jOut.y) / 2 - S.y);
  const lw = laneWidth(roadIn), width = Math.max(0.5, Math.hypot(jIn.x - jOut.x, jIn.y - jOut.y) - (roadIn.lanesF * lw) / 2 - (roadOut.lanesF * lw) / 2);
  return { S, road, roadIn, roadOut, jIn, jOut, len, width };
}

/** Take a splitter island away: the two ways back into one two-way road, ending where the two ended (between them), its connectors carried back. */
export function removeIsland(net: Network, id: string): { net: Network; link: string; end: string } | null {
  const it = islandAt(net, id);
  if (!it) return null;
  const { S, road, roadIn, roadOut, jIn, jOut } = it;
  const hand = junctionOf(net, jIn.id);
  // one end, between the two, holding what the way in held for the junction
  const J: NodeDef = { ...jIn, id: newId("n"), x: ops.round((jIn.x + jOut.x) / 2), y: ops.round((jIn.y + jOut.y) / 2) };
  if (hand?.nodes[0] === jIn.id && jIn.outline) {
    const mv = (p: Vec) => ({ x: ops.round(p.x + jIn.x - J.x), y: ops.round(p.y + jIn.y - J.y) });
    J.outline = jIn.outline.map(p => ({ ...p, ...mv(p) }));
    J.paint = jIn.paint?.map(a => ({ ...a, pts: a.pts.map(mv) }));
  }
  // (as the road it was: from S to the junction, its lanes into the junction forward)
  const P: LinkDef = { ...road, id: newId("l"), from: S.id, to: J.id, c1: null, c2: null, lanesF: roadIn.lanesF, lanesB: roadOut.lanesF, busF: roadIn.busF, busB: roadOut.busF,
    turnsF: roadIn.turnsF ?? null, signF: roadIn.signF ?? null, greenF: roadIn.greenF ?? null, baysF: roadIn.baysF ?? null, turnsB: null, signB: null, greenB: null, baysB: null };
  net = { ...net, nodes: [...net.nodes.filter(n => n.id !== jIn.id && n.id !== jOut.id), J], links: [...net.links.filter(l => l.id !== roadIn.id && l.id !== roadOut.id), P] };
  if (hand) {
    const remap = (k: string) => (k === `${roadIn.id}:1` ? `${P.id}:1` : k === `${roadOut.id}:1` ? `${P.id}:-1` : k);
    net = { ...net, junctions: net.junctions!.map(j => (j.id === hand.id ? { ...j, nodes: [...new Set(j.nodes.map(x => (x === jIn.id || x === jOut.id ? J.id : x)))] } : j)) };
    for (const x of net.junctions!.find(j => j.id === hand.id)!.nodes) net = ops.remapEdgeKeys(net, x, remap);
  }
  net = ops.updateNode(net, S.id, { align: undefined, paint: (S.paint ?? []).filter(a => a.kind !== "island").length ? S.paint!.filter(a => a.kind !== "island") : undefined });
  // the point it parted at goes: one road again
  const merged = ops.mergeLinks(net, [road.id, P.id]);
  return "error" in merged ? { net, link: P.id, end: J.id } : { net: merged.net, link: merged.id, end: J.id };
}

/** Change a splitter island's length or width: taken away, then made again. */
export function reshapeIsland(net: Network, id: string, len: number, width: number): { net: Network; island: string } | { error: string } {
  const it = islandAt(net, id);
  if (!it) return { error: "That isn't a splitter island any more." };
  const r = removeIsland(net, id);
  if (!r) return { error: "Couldn't take the island away." };
  return splitterIsland(r.net, r.link, r.end, len, width);
}
