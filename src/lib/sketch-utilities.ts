/**
 * Utility networks on the sketch (ticket #280): clean water, waste water, gas and electricity, drawn as lanes are
 * (a line through points, lines joined where they share a point) on three layers of their own (water, both water
 * networks; gas; electricity). Each network is a graph: its **nodes** are points in 3D (x, y as the plan's, metres, y
 * down; z metres over the ground there, negative below it), and its **lines** (pipes, cables) run through two nodes or
 * more, in order; lines sharing a node are joined there (a tee, a branch). A line is buried or not (visible: on the
 * ground, on supports, or overhead on poles), has a size (a pipe's diameter in mm, a cable's voltage in kV) and a
 * number of pipes or cables laid side by side (`count`: the "lanes" of a trench or a pole line).
 *
 * Only drawn and measured: the traffic simulation never sees them. Plain data and geometry, no framework.
 */
import type { Pt, Sketch } from "./lane-sketch";

export type UtilityNet = "water" | "sewer" | "gas" | "power";
/** the layers they are shown on (the water layer has both water networks) */
export type UtilityLayer = "water" | "gas" | "power";
export const UTILITY_NETS: readonly UtilityNet[] = ["water", "sewer", "gas", "power"];

export interface UtilityNode {
  id: string;
  net: UtilityNet;
  x: number; y: number;
  /** metres over the ground under it (negative: below it, buried) */
  z: number;
  /** what it is (a valve, a manhole, a pole, a substation…), as the user names it */
  name?: string;
}
export interface UtilityLine {
  id: string;
  net: UtilityNet;
  name: string;
  /** the nodes it runs through, in order (two at least; all of its network) */
  nodes: string[];
  /** under the ground (default: visible, on or over it) */
  buried?: true;
  /** a pipe's inside diameter (mm), a cable's voltage (kV); default the network's (`NET_INFO`) */
  size?: number;
  /** pipes or cables side by side (1, the default, to MAX_COUNT) */
  count?: number;
}

export interface NetInfo {
  label: string; short: string; layer: UtilityLayer; color: string;
  /** a new node's z, buried and not (m) */
  depth: number; height: number;
  /** what `size` is, and its default */
  sizeUnit: "mm" | "kV"; size: number;
  /** a new line's name, "… n" */
  noun: string;
}
/** colours from the usual utility marking code (APWA): blue drinking water, green sewers, yellow gas, red electricity */
export const NET_INFO: Record<UtilityNet, NetInfo> = {
  water: { label: "Clean water", short: "Water", layer: "water", color: "#2563eb", depth: -1.2, height: 0.5, sizeUnit: "mm", size: 150, noun: "Water main" },
  sewer: { label: "Waste water", short: "Sewer", layer: "water", color: "#15803d", depth: -2.5, height: 0.5, sizeUnit: "mm", size: 300, noun: "Sewer" },
  gas: { label: "Gas", short: "Gas", layer: "gas", color: "#eab308", depth: -1, height: 0.5, sizeUnit: "mm", size: 110, noun: "Gas main" },
  power: { label: "Electricity", short: "Power", layer: "power", color: "#dc2626", depth: -0.8, height: 9, sizeUnit: "kV", size: 20, noun: "Power line" },
};
export const UTILITY_LAYERS: { id: UtilityLayer; label: string; nets: UtilityNet[] }[] = [
  { id: "water", label: "Water", nets: ["water", "sewer"] },
  { id: "gas", label: "Gas", nets: ["gas"] },
  { id: "power", label: "Electricity", nets: ["power"] },
];
export const layerOfNet = (n: UtilityNet): UtilityLayer => NET_INFO[n].layer;
export const MAX_COUNT = 12;
/** how far below and above the ground a node may be (m) */
export const Z_MIN = -100, Z_MAX = 300;

const round = (v: number) => Math.round(v * 100) / 100;
const clampZ = (z: number) => round(Math.min(Z_MAX, Math.max(Z_MIN, z)));
const isNet = (v: unknown): v is UtilityNet => typeof v === "string" && (UTILITY_NETS as readonly string[]).includes(v);

export const nodesOf = (sk: Sketch) => sk.utilityNodes ?? [];
export const linesOf = (sk: Sketch) => sk.utilityLines ?? [];
export const nodeMap = (sk: Sketch) => new Map(nodesOf(sk).map(n => [n.id, n]));
export const lineSize = (l: UtilityLine) => l.size ?? NET_INFO[l.net].size;
export const lineCount = (l: UtilityLine) => l.count ?? 1;
/** a line's size as read: "150 mm", "20 kV" */
export const sizeLabel = (l: UtilityLine) => `${lineSize(l)} ${NET_INFO[l.net].sizeUnit}`;

/** the lines and nodes kept, the empty lists dropped */
function withUtilities(sk: Sketch, nodes: UtilityNode[], lines: UtilityLine[]): Sketch {
  const { utilityNodes: _, utilityLines: __, ...rest } = sk;
  return { ...rest, ...(nodes.length ? { utilityNodes: nodes } : {}), ...(lines.length ? { utilityLines: lines } : {}) };
}

/** the next free id with this prefix ("n1", "u1"…) */
function nextOf(prefix: string, ids: Iterable<string>): string {
  let n = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of ids) { const m = re.exec(id); if (m) n = Math.max(n, Number(m[1])); }
  return `${prefix}${n + 1}`;
}
export const nextNodeId = (nodes: UtilityNode[]) => nextOf("n", nodes.map(n => n.id));
export const nextLineId = (lines: UtilityLine[]) => nextOf("u", lines.map(l => l.id));

/** a line's nodes, in order (those missing left out) */
export function lineNodes(sk: Sketch, l: UtilityLine, map = nodeMap(sk)): UtilityNode[] {
  return l.nodes.flatMap(id => { const n = map.get(id); return n ? [n] : []; });
}
/** a line's points on the plan */
export const linePts = (sk: Sketch, l: UtilityLine, map = nodeMap(sk)): Pt[] => lineNodes(sk, l, map).map(n => ({ x: n.x, y: n.y }));

/**
 * A line's length (m): along the ground's plan (`plan`), and in 3D (`real`, its rises and falls counted: `ground` the
 * ground's height at a point, none flat)
 */
export function lineLength(sk: Sketch, l: UtilityLine, ground?: (p: Pt) => number, map = nodeMap(sk)): { plan: number; real: number } {
  const ns = lineNodes(sk, l, map), g = ground ?? (() => 0);
  let plan = 0, real = 0;
  for (let i = 1; i < ns.length; i++) {
    const a = ns[i - 1], b = ns[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    plan += d;
    real += Math.hypot(d, b.z + g(b) - (a.z + g(a)));
  }
  return { plan, real };
}

/** the lines through a node */
export const linesThrough = (sk: Sketch, node: string) => linesOf(sk).filter(l => l.nodes.includes(node));

/** a point of a line being drawn: an existing node of its network, a place on one of its lines (a tee there), or a new point */
export type UtilityDraftPt = { p: Pt; node?: string; on?: { line: string; seg: number } };

/** z of a point `t` (0…1) of the way along a line's segment `seg` (between its nodes seg and seg + 1) */
function zAlong(sk: Sketch, l: UtilityLine, seg: number, p: Pt, map: Map<string, UtilityNode>): number {
  const a = map.get(l.nodes[seg]), b = map.get(l.nodes[seg + 1]);
  if (!a || !b) return a?.z ?? b?.z ?? 0;
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return clampZ(a.z + (b.z - a.z) * t);
}

/**
 * A node put into line `id` between its nodes `seg` and `seg + 1` at `p` (its height the line's there): answers the
 * sketch and the new node's id (null: no such line or segment)
 */
export function insertNode(sk: Sketch, id: string, seg: number, p: Pt): [Sketch, string | null] {
  const l = linesOf(sk).find(x => x.id === id);
  if (!l || seg < 0 || seg >= l.nodes.length - 1) return [sk, null];
  const map = nodeMap(sk), nid = nextNodeId(nodesOf(sk));
  const node: UtilityNode = { id: nid, net: l.net, x: round(p.x), y: round(p.y), z: zAlong(sk, l, seg, p, map) };
  const lines = linesOf(sk).map(x => (x.id === id ? { ...x, nodes: [...x.nodes.slice(0, seg + 1), nid, ...x.nodes.slice(seg + 1)] } : x));
  return [withUtilities(sk, [...nodesOf(sk), node], lines), nid];
}

/**
 * A new line of network `net` through these points: a point on an existing node of the network joins it there, one on
 * a line of it puts a node into that line (a tee); the others are new nodes, at the network's depth (`buried`) or height.
 * Answers the sketch and the line (null if it has fewer than two distinct points).
 */
export function addUtilityLine(sk: Sketch, net: UtilityNet, pts: UtilityDraftPt[], opts: { buried?: boolean; size?: number; count?: number; name?: string } = {}): [Sketch, UtilityLine | null] {
  const info = NET_INFO[net], ids: string[] = [];
  let k = sk;
  for (const q of pts) {
    let id: string | null = null;
    if (q.node && nodesOf(k).some(n => n.id === q.node && n.net === net)) id = q.node;
    else if (q.on && linesOf(k).some(l => l.id === q.on!.line && l.net === net)) {
      // (its segment found again: a tee put in the same line just before shifts them)
      const at = utilityLineAt(k, q.p, Infinity, undefined, q.on.line);
      [k, id] = insertNode(k, q.on.line, at?.seg ?? q.on.seg, at?.q ?? q.p);
    }
    if (!id) {
      id = nextNodeId(nodesOf(k));
      k = withUtilities(k, [...nodesOf(k), { id, net, x: round(q.p.x), y: round(q.p.y), z: opts.buried ? info.depth : info.height }], linesOf(k));
    }
    if (ids[ids.length - 1] !== id) ids.push(id);
  }
  if (ids.length < 2) return [sk, null];
  const lines = linesOf(k), lid = nextLineId(lines), n = lines.filter(l => l.net === net).length + 1;
  const line: UtilityLine = {
    id: lid, net, name: opts.name ?? `${info.noun} ${n}`, nodes: ids, ...(opts.buried ? { buried: true as const } : {}),
    ...(opts.size && opts.size !== info.size ? { size: opts.size } : {}), ...(opts.count && opts.count > 1 ? { count: Math.min(MAX_COUNT, Math.round(opts.count)) } : {}),
  };
  return [withUtilities(k, nodesOf(k), [...lines, line]), line];
}

/** nodes no line runs through taken out */
function dropLoose(sk: Sketch): Sketch {
  const used = new Set(linesOf(sk).flatMap(l => l.nodes));
  const nodes = nodesOf(sk).filter(n => used.has(n.id));
  return nodes.length === nodesOf(sk).length ? sk : withUtilities(sk, nodes, linesOf(sk));
}

/** lines deleted, and the nodes left on no line */
export function deleteUtilityLines(sk: Sketch, ids: Iterable<string>): Sketch {
  const set = new Set(ids);
  if (!linesOf(sk).some(l => set.has(l.id))) return sk;
  return dropLoose(withUtilities(sk, nodesOf(sk), linesOf(sk).filter(l => !set.has(l.id))));
}

/** a node deleted: taken out of each line through it (its neighbours then joined); a line left with one node goes */
export function deleteUtilityNode(sk: Sketch, id: string): Sketch {
  if (!nodesOf(sk).some(n => n.id === id)) return sk;
  const lines = linesOf(sk).flatMap(l => {
    if (!l.nodes.includes(id)) return [l];
    const nodes = l.nodes.filter(n => n !== id).filter((n, i, a) => i === 0 || a[i - 1] !== n);
    return nodes.length >= 2 ? [{ ...l, nodes }] : [];
  });
  return dropLoose(withUtilities(sk, nodesOf(sk).filter(n => n.id !== id), lines));
}

/** line `id`'s node `i` taken out of it (it keeping two at least); the node goes if no other line runs through it */
export function removeNodeFromLine(sk: Sketch, id: string, i: number): Sketch {
  const l = linesOf(sk).find(x => x.id === id);
  if (!l || l.nodes.length <= 2 || i < 0 || i >= l.nodes.length) return sk;
  const nodes = l.nodes.filter((_, k) => k !== i).filter((n, k, a) => k === 0 || a[k - 1] !== n);
  if (nodes.length < 2) return sk;
  return dropLoose(withUtilities(sk, nodesOf(sk), linesOf(sk).map(x => (x.id === id ? { ...x, nodes } : x))));
}

/**
 * Node `drop` merged into node `keep` (of the same network; a node dragged onto another): the lines through it run
 * through `keep` instead, a line left with one node goes
 */
export function mergeUtilityNodes(sk: Sketch, keep: string, drop: string): Sketch {
  const map = nodeMap(sk), a = map.get(keep), b = map.get(drop);
  if (!a || !b || a.id === b.id || a.net !== b.net) return sk;
  const lines = linesOf(sk).flatMap(l => {
    if (!l.nodes.includes(drop)) return [l];
    const nodes = l.nodes.map(n => (n === drop ? keep : n)).filter((n, i, x) => i === 0 || x[i - 1] !== n);
    return nodes.length >= 2 ? [{ ...l, nodes }] : [];
  });
  return dropLoose(withUtilities(sk, nodesOf(sk).filter(n => n.id !== drop), lines));
}

/** a node moved (on the plan, and / or up or down: z over the ground) */
export function moveUtilityNode(sk: Sketch, id: string, to: { x?: number; y?: number; z?: number }): Sketch {
  return withUtilities(sk, nodesOf(sk).map(n => (n.id !== id ? n : {
    ...n, ...(to.x !== undefined && Number.isFinite(to.x) ? { x: round(to.x) } : {}), ...(to.y !== undefined && Number.isFinite(to.y) ? { y: round(to.y) } : {}),
    ...(to.z !== undefined && Number.isFinite(to.z) ? { z: clampZ(to.z) } : {}),
  })), linesOf(sk));
}
/** a node renamed (empty: no name) */
export function renameUtilityNode(sk: Sketch, id: string, name: string): Sketch {
  return withUtilities(sk, nodesOf(sk).map(n => { if (n.id !== id) return n; const { name: _, ...rest } = n; const t = name.trim().slice(0, 120); return t ? { ...rest, name: t } : rest; }), linesOf(sk));
}

export type LinePatch = { name?: string; net?: UtilityNet; buried?: boolean; size?: number | null; count?: number };
/**
 * A line changed. Its network changed: its nodes shared with other lines copied into its own first (the other lines
 * keep theirs), so a network's lines only ever join its own. Buried or not changed: its nodes on the wrong side of the
 * ground (shared ones too) moved to the network's depth or height. `size` null: the network's.
 */
export function updateUtilityLine(sk: Sketch, id: string, patch: LinePatch): Sketch {
  const l = linesOf(sk).find(x => x.id === id);
  if (!l) return sk;
  let nodes = nodesOf(sk), line: UtilityLine = { ...l };
  if (patch.name !== undefined) line.name = patch.name.trim().slice(0, 120) || l.name;
  if (patch.net && patch.net !== l.net) {
    const others = new Set(linesOf(sk).filter(x => x.id !== id).flatMap(x => x.nodes)), map = new Map(nodes.map(n => [n.id, n])), swap = new Map<string, string>();
    for (const nid of new Set(l.nodes)) {
      const n = map.get(nid);
      if (!n) continue;
      if (others.has(nid)) { const c = { ...n, id: nextNodeId(nodes), net: patch.net }; delete c.name; nodes = [...nodes, c]; swap.set(nid, c.id); }
      else nodes = nodes.map(x => (x.id === nid ? { ...x, net: patch.net! } : x));
    }
    line = { ...line, net: patch.net, nodes: line.nodes.map(n => swap.get(n) ?? n) };
    if (line.size !== undefined && NET_INFO[patch.net].sizeUnit !== NET_INFO[l.net].sizeUnit) delete line.size;
  }
  if (patch.buried !== undefined && patch.buried !== !!l.buried) {
    if (patch.buried) line.buried = true; else delete line.buried;
    const info = NET_INFO[line.net], mine = new Set(line.nodes);
    nodes = nodes.map(n => (!mine.has(n.id) ? n : patch.buried ? (n.z >= 0 ? { ...n, z: info.depth } : n) : n.z < 0 ? { ...n, z: info.height } : n));
  }
  if (patch.size !== undefined) {
    if (patch.size === null || !Number.isFinite(patch.size) || patch.size <= 0 || patch.size === NET_INFO[line.net].size) delete line.size;
    else line.size = round(Math.min(100000, patch.size));
  }
  if (patch.count !== undefined) {
    const c = Math.round(Math.min(MAX_COUNT, Math.max(1, patch.count || 1)));
    if (c > 1) line.count = c; else delete line.count;
  }
  return dropLoose(withUtilities(sk, nodes, linesOf(sk).map(x => (x.id === id ? line : x))));
}

/** these lines' nodes moved by `pt` (moving, turning a piece; their nodes shared with other lines too) */
export function transformUtilities(sk: Sketch, ids: Iterable<string>, pt: (p: Pt) => Pt): Sketch {
  const set = new Set(ids), mine = new Set(linesOf(sk).filter(l => set.has(l.id)).flatMap(l => l.nodes));
  if (!mine.size) return sk;
  return withUtilities(sk, nodesOf(sk).map(n => { if (!mine.has(n.id)) return n; const q = pt(n); return { ...n, x: round(q.x), y: round(q.y) }; }), linesOf(sk));
}
/** these lines' points (fitting the view to them, a piece's bounds) */
export function utilityPoints(sk: Sketch, ids: Iterable<string>): Pt[] {
  const set = new Set(ids), map = nodeMap(sk);
  return linesOf(sk).filter(l => set.has(l.id)).flatMap(l => linePts(sk, l, map));
}

/** lines to paste: these, with their nodes (as they are) */
export function copyUtilities(sk: Sketch, ids: Iterable<string>): { nodes: UtilityNode[]; lines: UtilityLine[] } {
  const set = new Set(ids), lines = linesOf(sk).filter(l => set.has(l.id)), used = new Set(lines.flatMap(l => l.nodes));
  return { nodes: nodesOf(sk).filter(n => used.has(n.id)), lines };
}
/** lines (and their nodes) pasted in with fresh ids and "… copy" names, moved by (dx, dy); answers the sketch and the new lines' ids */
export function pasteUtilities(sk: Sketch, part: { nodes?: UtilityNode[]; lines?: UtilityLine[] }, dx: number, dy: number): { sketch: Sketch; ids: string[] } {
  const src = part.lines ?? [];
  if (!src.length) return { sketch: sk, ids: [] };
  const nodes = [...nodesOf(sk)], lines = [...linesOf(sk)], swap = new Map<string, string>(), ids: string[] = [];
  for (const n of part.nodes ?? []) {
    const id = nextNodeId(nodes);
    nodes.push({ ...n, id, x: round(n.x + dx), y: round(n.y + dy) });
    swap.set(n.id, id);
  }
  for (const l of src) {
    const ns = l.nodes.map(n => swap.get(n));
    if (ns.some(n => !n)) continue;
    const id = nextLineId(lines);
    lines.push({ ...l, id, name: / copy$/.test(l.name) ? l.name : `${l.name} copy`, nodes: ns as string[] });
    ids.push(id);
  }
  return { sketch: dropLoose(withUtilities(sk, nodes, lines)), ids };
}

// ---------------------------------------------------------------- finding them on the plan

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, t = L ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  const q = { x: a.x + dx * t, y: a.y + dy * t };
  return { d: Math.hypot(p.x - q.x, p.y - q.y), q };
};
/** the network shown: of these layers */
export const netShown = (layers: Partial<Record<UtilityLayer, boolean>>, net: UtilityNet) => !!layers[layerOfNet(net)];

/** the line nearest `p` within `tol` metres (of the networks `nets`, else any): its id, the segment and the point on it */
export function utilityLineAt(sk: Sketch, p: Pt, tol: number, nets?: (n: UtilityNet) => boolean, only?: string): { line: string; seg: number; q: Pt; d: number } | null {
  const map = nodeMap(sk);
  let best: { line: string; seg: number; q: Pt; d: number } | null = null;
  for (const l of linesOf(sk)) {
    if ((nets && !nets(l.net)) || (only && l.id !== only)) continue;
    const pts = linePts(sk, l, map);
    for (let i = 1; i < pts.length; i++) {
      const r = segDist(p, pts[i - 1], pts[i]);
      if (r.d <= tol && (!best || r.d < best.d)) best = { line: l.id, seg: i - 1, q: r.q, d: r.d };
    }
  }
  return best;
}
/** the node nearest `p` within `tol` metres (of the networks `nets`, else any) */
export function utilityNodeAt(sk: Sketch, p: Pt, tol: number, nets?: (n: UtilityNet) => boolean): UtilityNode | null {
  let best: UtilityNode | null = null, bd = tol;
  for (const n of nodesOf(sk)) {
    if (nets && !nets(n.net)) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= bd) { bd = d; best = n; }
  }
  return best;
}

/** a line drawn `off` metres to the left of `pts` as they run (corners mitred, not past 3 times `off`) */
export function offsetPolyline(pts: Pt[], off: number): Pt[] {
  if (!off || pts.length < 2) return pts;
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const d1 = unit(i > 0 ? p.x - a.x : b.x - p.x, i > 0 ? p.y - a.y : b.y - p.y), d2 = unit(i < n - 1 ? b.x - p.x : p.x - a.x, i < n - 1 ? b.y - p.y : p.y - a.y);
    // (left of the way it runs, y down: (d.y, -d.x))
    let mx = d1.y + d2.y, my = -(d1.x + d2.x);
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const cos = Math.max(1 / 3, mx * d2.y - my * d2.x);
    return { x: p.x + (mx * off) / cos, y: p.y + (my * off) / cos };
  });
}
const unit = (x: number, y: number) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
/** how far apart a line's pipes or cables are (m, centre to centre): a pipe's diameter and a half; overhead conductors 0.8 m */
export function strandSpacing(l: UtilityLine): number {
  if (NET_INFO[l.net].sizeUnit === "kV") return l.buried ? 0.3 : 0.8;
  return Math.max(0.25, (lineSize(l) / 1000) * 1.5);
}
/** a line's strands' offsets from its middle (m), left to right */
export function strandOffsets(l: UtilityLine): number[] {
  const c = lineCount(l), s = strandSpacing(l);
  return Array.from({ length: c }, (_, i) => (i - (c - 1) / 2) * s);
}
/** how thick a strand is drawn (m): a pipe its diameter, a cable 0.1 m (thicker the higher its voltage) */
export function strandWidth(l: UtilityLine): number {
  return NET_INFO[l.net].sizeUnit === "mm" ? Math.max(0.05, lineSize(l) / 1000) : Math.min(0.3, 0.06 + lineSize(l) / 1000);
}

/** each network's lines, nodes and length (m, on the plan) */
export function utilityTotals(sk: Sketch): Record<UtilityNet, { lines: number; nodes: number; length: number }> {
  const map = nodeMap(sk), out = Object.fromEntries(UTILITY_NETS.map(n => [n, { lines: 0, nodes: 0, length: 0 }])) as Record<UtilityNet, { lines: number; nodes: number; length: number }>;
  for (const l of linesOf(sk)) { out[l.net].lines++; out[l.net].length += lineLength(sk, l, undefined, map).plan; }
  for (const n of nodesOf(sk)) out[n.net].nodes++;
  return out;
}

// ---------------------------------------------------------------- stored

/** a node as stored, checked: null if it can't be one */
export function sanitizeUtilityNode(raw: unknown): UtilityNode | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || !isNet(o.net) || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 120) : undefined;
  return { id: o.id, net: o.net, x: round(o.x as number), y: round(o.y as number), z: Number.isFinite(o.z) ? clampZ(o.z as number) : 0, ...(name ? { name } : {}) };
}
/**
 * A sketch's utility nodes and lines as stored, checked: ids unique (a repeated one dropped), a line's nodes those of
 * its network that are there (one repeated straight after itself once), two at least or the line goes. Nodes on no line
 * are kept (a patch removing a line leaves them, as it says).
 */
export function sanitizeUtilities(rawNodes: unknown, rawLines: unknown): { nodes: UtilityNode[]; lines: UtilityLine[] } {
  const seen = new Set<string>(), nodes: UtilityNode[] = [];
  for (const r of Array.isArray(rawNodes) ? rawNodes : []) {
    const n = sanitizeUtilityNode(r);
    if (n && !seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
  }
  const map = new Map(nodes.map(n => [n.id, n])), lseen = new Set<string>(), lines: UtilityLine[] = [];
  for (const r of Array.isArray(rawLines) ? rawLines : []) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || lseen.has(o.id) || !isNet(o.net) || !Array.isArray(o.nodes)) continue;
    const net = o.net;
    const ns = o.nodes.filter((x): x is string => typeof x === "string" && map.get(x)?.net === net).filter((x, i, a) => i === 0 || a[i - 1] !== x);
    if (ns.length < 2) continue;
    lseen.add(o.id);
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 120) : `${NET_INFO[net].noun} ${o.id.replace(/^u/, "")}`;
    const size = typeof o.size === "number" && Number.isFinite(o.size) && o.size > 0 && o.size !== NET_INFO[net].size ? round(Math.min(100000, o.size)) : undefined;
    const count = typeof o.count === "number" && Number.isFinite(o.count) ? Math.round(Math.min(MAX_COUNT, Math.max(1, o.count))) : 1;
    lines.push({ id: o.id, net, name, nodes: ns, ...(o.buried === true ? { buried: true as const } : {}), ...(size !== undefined ? { size } : {}), ...(count > 1 ? { count } : {}) });
  }
  return { nodes, lines };
}
