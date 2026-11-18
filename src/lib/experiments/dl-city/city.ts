/**
 * The deep-learning city experiment (ticket #277): a random city with the traits of Bistrița Auto Search (an OSM import of a
 * Romanian county town, 2.3 × 2 km): a dense old centre (blocks about 100 m) with a ring boulevard round it, sparser blocks
 * further out, a main road from the south-west to the north-east straight through the centre, a cross boulevard, two longer
 * bypasses (south-east and north-west), streets missing here and there, dead ends (car parks, courtyards: where trips start
 * and end inside the town), and roads leaving the town all round.
 *
 * Built on a lattice turned 45° (its `u` axis along the main road, south-west to north-east; `w` across it, toward the
 * south-east), its spacing growing away from the centre, warped and jittered so streets bend. Everything is seeded: the same
 * seed, the same city. Plain TypeScript (runs in Node and in the browser).
 */

export type Rng = () => number;
/** mulberry32: small, fast, seeded */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface XY { x: number; y: number }

/** the streets a design may give four lanes (two each way), at most two of them (the ticket's rule) */
export const STREETS = [
  { id: "mainW", name: "Calea Apusului", what: "main road, west of the ring" },
  { id: "mainC", name: "Strada Mare", what: "main road, through the centre (inside the ring)" },
  { id: "mainE", name: "Calea Răsăritului", what: "main road, east of the ring" },
  { id: "ring", name: "Bulevardul Inelar", what: "the ring boulevard round the centre" },
  { id: "bypassSE", name: "Centura Sud-Est", what: "the south-east bypass" },
  { id: "bypassNW", name: "Centura Nord-Vest", what: "the north-west bypass" },
  { id: "station", name: "Bulevardul Gării", what: "the cross boulevard (north-west to south-east, through the centre)" },
] as const;
export type StreetId = (typeof STREETS)[number]["id"];

/** the junctions a design sets the control of */
export type JunctionControl = "priority" | "lights" | "roundabout";
export const CONTROLS: readonly JunctionControl[] = ["priority", "lights", "roundabout"];

export interface CityNode { id: number; i: number; w: number; x: number; y: number; centre: boolean }
export interface CityLink {
  id: number; a: number; b: number; name: string;
  /** the named main street it is part of (a design may give it four lanes), else a local street */
  street: StreetId | null;
  /** inside the ring (a design may make it one-way or close it to cars) */
  centre: boolean;
}
export type GatewayKind = "main" | "edge" | "park" | "parkCentre";
export interface Gateway { node: number; kind: GatewayKind; /** veh/h coming in (its own trips, to anywhere), and its share of the trips going out */ inRate: number; outWeight: number }
export interface KeyJunction { node: number; name: string; /** what it is in the status quo */ base: JunctionControl }
export interface City {
  seed: number; name: string;
  nodes: CityNode[]; links: CityLink[]; gateways: Gateway[]; keys: KeyJunction[];
  /** the main road's two ends (gateway nodes): south-west and north-east */
  sw: number; ne: number;
  /** the centre: inside the ring (plan metres, a closed polygon), and the rotation's unit vectors */
  centre: XY[];
  /** corridor demand (veh/h each way, on top of the gateways' own) */
  corridor: number;
  /** the gateways' own demand, times DEMAND's */
  load: number;
}

const C = Math.SQRT1_2;
/** plan metres (x east, y south) of lattice metres (u toward the north-east, w toward the south-east) */
export const toXY = (u: number, w: number): XY => ({ x: C * (u + w), y: C * (w - u) });
export const toUW = (p: XY) => ({ u: C * (p.x - p.y), w: C * (p.x + p.y) });

/** lattice spacing (m) out from the centre: 100 m blocks in the old town, growing to 230 m */
const SP_U = [100, 100, 105, 115, 130, 150, 170, 190, 210];
const SP_W = [100, 100, 105, 115, 135, 160];
const cum = (sp: number[]) => { const o = [0]; for (const s of sp) o.push(o[o.length - 1] + s); return o; };
const UU = cum(SP_U), WW = cum(SP_W);
export const N = SP_U.length, M = SP_W.length;
/** the ring: the lattice square |i| = 3 or |w| = 3, corners cut off */
export const RING = 3;

const ROMANIAN = ["Teilor", "Morii", "Viilor", "Florilor", "Pădurii", "Livezii", "Izvorului", "Crinului", "Salcâmilor", "Fagului", "Bradului", "Stejarului", "Plopilor", "Zorilor", "Primăverii", "Școlii", "Bisericii", "Țesătorilor", "Olarilor", "Dogarilor", "Cojocarilor", "Rotarilor", "Ciobanului", "Grădinilor", "Câmpului", "Luncii", "Dealului", "Văii", "Podului", "Morarilor", "Lalelelor", "Trandafirilor", "Ghiocelului", "Castanilor", "Nucului", "Mesteacănului", "Arinului", "Socului", "Cireșilor", "Merilor", "Prunilor", "Zăvoiului", "Fântânii", "Pieței", "Târgului", "Libertății", "Unirii", "Păcii", "Muncii", "Sportului", "Tineretului", "Parcului", "Băilor", "Gării Vechi", "Cetății", "Turnului", "Zidului", "Porții", "Aurarilor", "Croitorilor"];
const PREFIX = ["Strada", "Strada", "Strada", "Aleea", "Intrarea"];
const TOWNS = ["Valea Șoimului", "Dealu Frumos", "Pietrele Albe", "Lunca Mare", "Izvoarele Noi", "Poiana Verde", "Râul Lin", "Câmpu Nou"];

/** a random city (the same for the same seed) */
export function generateCity(seed: number): City {
  const R = rng(seed * 7919 + 17);
  const jit = (s: number) => (R() * 2 - 1) * s;
  // a smooth warp, so streets bend (a few long waves)
  const waves = Array.from({ length: 4 }, () => ({ k: 0.002 + R() * 0.003, ph: R() * 6.28, a: 14 + R() * 14, dir: R() * 6.28 }));
  const warp = (u: number, w: number) => {
    let du = 0, dw = 0;
    for (const v of waves) { const s = Math.sin((u * Math.cos(v.dir) + w * Math.sin(v.dir)) * v.k + v.ph) * v.a; du += s * Math.sin(v.dir); dw -= s * Math.cos(v.dir); }
    return { du, dw };
  };
  const pos = (i: number) => Math.sign(i) * UU[Math.abs(i)], posW = (w: number) => Math.sign(w) * WW[Math.abs(w)];
  // the town's outline: an ellipse along the main road, its edge ragged
  const inTown = (i: number, w: number) => {
    const u = pos(i), ww = posW(w), e = (u / 1320) ** 2 + (ww / 640) ** 2;
    return e <= 1 + jit(0.18) || w === 0 || (Math.abs(i) <= RING && Math.abs(w) <= RING);
  };
  const key = (i: number, w: number) => `${i},${w}`;
  const nodes: CityNode[] = [], at = new Map<string, number>();
  const ringCorner = (i: number, w: number) => Math.abs(i) === RING && Math.abs(w) === RING;
  for (let i = -N; i <= N; i++) for (let w = -M; w <= M; w++) {
    if (!inTown(i, w) || ringCorner(i, w)) continue;
    const centre = Math.abs(i) < RING && Math.abs(w) < RING;
    const u = pos(i), ww = posW(w), d = warp(u, ww), j = centre ? 5 : 11;
    // (the main road and the centre's straight streets bend less)
    const k = w === 0 ? 0.35 : 1;
    const p = toXY(u + (d.du + jit(j)) * k, ww + (d.dw + jit(j)) * (w === 0 ? 0.25 : 1));
    at.set(key(i, w), nodes.length);
    nodes.push({ id: nodes.length, i, w, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, centre });
  }
  const nodeAt = (i: number, w: number) => at.get(key(i, w));
  const links: CityLink[] = [], edgeKey = new Set<string>();
  const usedCell = new Set<string>();
  const addLink = (a: number | undefined, b: number | undefined, street: StreetId | null, name: string) => {
    if (a === undefined || b === undefined || a === b) return;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeKey.has(k)) return;
    edgeKey.add(k);
    const A = nodes[a], B = nodes[b];
    const centre = Math.abs(A.i) <= RING && Math.abs(A.w) <= RING && Math.abs(B.i) <= RING && Math.abs(B.w) <= RING && !(street === "ring");
    links.push({ id: links.length, a, b, name, street, centre });
  };
  // the main streets first (they are never left out)
  const streetName = (id: StreetId) => STREETS.find(s => s.id === id)!.name;
  for (let i = -N; i < N; i++) {
    const s: StreetId = i < -RING ? "mainW" : i >= RING ? "mainE" : "mainC";
    addLink(nodeAt(i, 0), nodeAt(i + 1, 0), s, streetName(s));
  }
  for (let w = -M; w < M; w++) addLink(nodeAt(0, w), nodeAt(0, w + 1), "station", streetName("station"));
  // the ring: its four sides, the corners cut
  for (let k = -RING + 1; k < RING - 1; k++) {
    addLink(nodeAt(k, -RING), nodeAt(k + 1, -RING), "ring", streetName("ring")); addLink(nodeAt(k, RING), nodeAt(k + 1, RING), "ring", streetName("ring"));
    addLink(nodeAt(-RING, k), nodeAt(-RING, k + 1), "ring", streetName("ring")); addLink(nodeAt(RING, k), nodeAt(RING, k + 1), "ring", streetName("ring"));
  }
  for (const [si, sw] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    addLink(nodeAt(si * (RING - 1), sw * RING), nodeAt(si * RING, sw * (RING - 1)), "ring", streetName("ring"));
    usedCell.add(key(si > 0 ? RING - 1 : -RING, sw > 0 ? RING - 1 : -RING));
  }
  // the bypasses: diagonals across the cells (no street crossed), then along the lattice
  const path = (pts: [number, number][], s: StreetId) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [i1, w1] = pts[k], [i2, w2] = pts[k + 1];
      if (Math.abs(i1 - i2) === 1 && Math.abs(w1 - w2) === 1) usedCell.add(key(Math.min(i1, i2), Math.min(w1, w2)));
      addLink(nodeAt(i1, w1), nodeAt(i2, w2), s, streetName(s));
    }
  };
  const se: [number, number][] = [[-7, 0], [-6, 1], [-5, 2], [-4, 3], [-3, 4]];
  for (let i = -2; i <= 3; i++) se.push([i, 4]);
  se.push([4, 3], [5, 2], [6, 1], [7, 0]);
  path(se, "bypassSE");
  const nw: [number, number][] = [[-6, 0], [-5, -1], [-4, -2], [-4, -3], [-3, -4]];
  for (let i = -2; i <= 3; i++) nw.push([i, -4]);
  nw.push([4, -3], [4, -2], [5, -1], [6, 0]);
  path(nw, "bypassNW");
  // local streets: the lattice's own, a few left out (fewer in the centre), named by the line they run along
  const names = new Map<string, string>(), pick = <T,>(a: readonly T[]) => a[Math.floor(R() * a.length)];
  const nameOf = (k: string) => names.get(k) ?? (names.set(k, `${pick(PREFIX)} ${pick(ROMANIAN)}`), names.get(k)!);
  const cand: [number, number, string][] = [];
  for (let i = -N; i <= N; i++) for (let w = -M; w <= M; w++) {
    const a = nodeAt(i, w);
    if (a === undefined) continue;
    cand.push([a, nodeAt(i + 1, w) ?? -1, `u${w}:${Math.floor(i / 4)}`], [a, nodeAt(i, w + 1) ?? -1, `w${i}:${Math.floor(w / 3)}`]);
  }
  for (const [a, b, line] of cand) {
    if (b < 0) continue;
    const A = nodes[a], B = nodes[b], centre = Math.abs(A.i) <= RING && Math.abs(A.w) <= RING && Math.abs(B.i) <= RING && Math.abs(B.w) <= RING;
    if (R() < (centre ? 0.04 : 0.13)) continue;
    addLink(a, b, null, nameOf(line));
  }
  // a few diagonal streets out of the centre (as old towns' radial roads), in cells nothing else crosses
  for (let i = -N; i < N; i++) for (let w = -M; w < M; w++) {
    if (usedCell.has(key(i, w)) || (Math.abs(i + 0.5) < RING + 1 && Math.abs(w + 0.5) < RING + 1) || R() > 0.07) continue;
    const flip = R() < 0.5, a = flip ? nodeAt(i, w) : nodeAt(i + 1, w), b = flip ? nodeAt(i + 1, w + 1) : nodeAt(i, w + 1);
    if (a === undefined || b === undefined) continue;
    usedCell.add(key(i, w));
    addLink(a, b, null, `${pick(PREFIX)} ${pick(ROMANIAN)}`);
  }
  // only what is joined to the main road
  const adj = new Map<number, number[]>();
  for (const l of links) { (adj.get(l.a) ?? adj.set(l.a, []).get(l.a)!).push(l.b); (adj.get(l.b) ?? adj.set(l.b, []).get(l.b)!).push(l.a); }
  const seen = new Set<number>([nodeAt(0, 0)!]), q = [nodeAt(0, 0)!];
  while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  const keepLinks = links.filter(l => seen.has(l.a) && seen.has(l.b));
  // gateways: dead-end stubs (as the plan's ways in and out). Off the main road's ends; off the edge of town where a street
  // would go on; into the blocks (car parks, courtyards), more of them in the centre
  const gateways: Gateway[] = [], stubs: { from: number; p: XY; kind: GatewayKind }[] = [];
  const nodePos = (n: number) => ({ x: nodes[n].x, y: nodes[n].y });
  const out = (n: number, du: number, dw: number, len: number) => { const A = toUW(nodePos(n)); return toXY(A.u + du * len, A.w + dw * len); };
  const swN = nodeAt(-N, 0)!, neN = nodeAt(N, 0)!;
  stubs.push({ from: swN, p: out(swN, -1, 0, 110), kind: "main" }, { from: neN, p: out(neN, 1, 0, 110), kind: "main" });
  const degree = new Map<number, number>();
  for (const l of keepLinks) { degree.set(l.a, (degree.get(l.a) ?? 0) + 1); degree.set(l.b, (degree.get(l.b) ?? 0) + 1); }
  for (const n of nodes) {
    if (!seen.has(n.id) || n.w === 0) continue;
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [di, dw] of dirs) {
      // (not into a cut corner of the ring: that is inside the town)
      if (nodeAt(n.i + di, n.w + dw) !== undefined || ringCorner(n.i + di, n.w + dw) || Math.abs(n.i + di) > N + 1 || (degree.get(n.id) ?? 0) >= 4) continue;
      if (R() < 0.45) { stubs.push({ from: n.id, p: out(n.id, di, dw, 70), kind: "edge" }); degree.set(n.id, (degree.get(n.id) ?? 0) + 1); break; }
    }
  }
  // car parks: half-way along a local street, into the block beside it (the street split there, a T-junction)
  const allLinks = keepLinks.map((l, k) => ({ ...l, id: k }));
  const linkOf = new Map(allLinks.map(l => [l.a < l.b ? `${l.a}-${l.b}` : `${l.b}-${l.a}`, l]));
  const split = new Set<number>();
  for (let i = -N; i < N; i++) for (let w = -M; w < M; w++) {
    if (usedCell.has(key(i, w))) continue;
    const centre = Math.abs(i + 0.5) < RING && Math.abs(w + 0.5) < RING;
    if (R() > (centre ? 0.5 : 0.22)) continue;
    const sides = ([[[i, w], [i + 1, w]], [[i, w + 1], [i + 1, w + 1]], [[i, w], [i, w + 1]], [[i + 1, w], [i + 1, w + 1]]] as [number, number][][])
      .map(([p, q]) => { const a = nodeAt(p[0], p[1]), b = nodeAt(q[0], q[1]); return a === undefined || b === undefined ? undefined : linkOf.get(a < b ? `${a}-${b}` : `${b}-${a}`); })
      .filter((l): l is CityLink => !!l && l.street === null && !split.has(l.id) && seen.has(l.a));
    if (!sides.length) continue;
    const l = pick(sides), A = nodes[l.a], B = nodes[l.b];
    usedCell.add(key(i, w)); split.add(l.id);
    const mid = nodes.length, mi = (A.i + B.i) / 2, mw = (A.w + B.w) / 2;
    nodes.push({ id: mid, i: mi, w: mw, x: Math.round(((A.x + B.x) / 2) * 10) / 10, y: Math.round(((A.y + B.y) / 2) * 10) / 10, centre });
    allLinks.push({ ...l, id: allLinks.length, a: mid, b: l.b });
    l.b = mid;
    // (toward the cell's middle)
    const cu = toXY(pos(i) / 2 + pos(i + 1) / 2, posW(w) / 2 + posW(w + 1) / 2), M0 = nodes[mid], d = Math.hypot(cu.x - M0.x, cu.y - M0.y), len = Math.min(40, d * 0.6);
    stubs.push({ from: mid, p: { x: M0.x + ((cu.x - M0.x) / d) * len, y: M0.y + ((cu.y - M0.y) / d) * len }, kind: centre ? "parkCentre" : "park" });
  }
  for (const s of stubs) {
    const g = nodes.length;
    nodes.push({ id: g, i: NaN, w: NaN, x: Math.round(s.p.x * 10) / 10, y: Math.round(s.p.y * 10) / 10, centre: s.kind === "parkCentre" });
    const main = s.kind === "main";
    allLinks.push({ id: allLinks.length, a: s.from, b: g, name: main ? streetName(s.from === swN ? "mainW" : "mainE") : s.kind === "edge" ? `${pick(["Drumul", "Calea", "Drumul"])} spre ${pick(TOWNS)}` : `Parcarea ${pick(ROMANIAN)}`, street: main ? (s.from === swN ? "mainW" : "mainE") : null, centre: false });
    gateways.push({ node: g, kind: s.kind, ...DEMAND[s.kind] });
  }
  const keys: KeyJunction[] = [
    { node: nodeAt(-RING, 0)!, name: "Main road × ring, west", base: "lights" },
    { node: nodeAt(RING, 0)!, name: "Main road × ring, east", base: "lights" },
    { node: nodeAt(0, 0)!, name: "Centre: main road × Bulevardul Gării", base: "lights" },
    { node: nodeAt(0, -RING)!, name: "Bulevardul Gării × ring, north", base: "priority" },
    { node: nodeAt(0, RING)!, name: "Bulevardul Gării × ring, south", base: "priority" },
    { node: nodeAt(-7, 0)!, name: "SE bypass, west end", base: "priority" },
    { node: nodeAt(7, 0)!, name: "SE bypass, east end", base: "priority" },
    { node: nodeAt(-6, 0)!, name: "NW bypass, west end", base: "priority" },
    { node: nodeAt(6, 0)!, name: "NW bypass, east end", base: "priority" },
  ];
  const r = RING, cr = [[-r + 1, -r], [r - 1, -r], [r, -r + 1], [r, r - 1], [r - 1, r], [-r + 1, r], [-r, r - 1], [-r, -r + 1]];
  const centre = cr.map(([i, w]) => nodePos(nodeAt(i, w)!));
  return { seed, name: `${TOWNS[seed % TOWNS.length]} (random city, seed ${seed})`, nodes, links: allLinks, gateways, keys, sw: nodes.length - stubs.length, ne: nodes.length - stubs.length + 1, centre, corridor: CORRIDOR, load: LOAD };
}

/** demand: veh/h in at each kind of way in (its own trips, to anywhere), and its share of the trips out */
export const DEMAND: Record<GatewayKind, { inRate: number; outWeight: number }> = {
  main: { inRate: 250, outWeight: 3 },
  edge: { inRate: 40, outWeight: 1 },
  park: { inRate: 20, outWeight: 1 },
  parkCentre: { inRate: 30, outWeight: 3 },
};
/** veh/h each way along the main road, south-west to north-east and back (journeys, on top) */
export const CORRIDOR = 700;
/** the gateways' demand, times DEMAND's */
export const LOAD = 1.5;

/** is a point inside a polygon */
export function inside(p: XY, poly: XY[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
