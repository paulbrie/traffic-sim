/**
 * Road surface under the connectors on no junction (ticket #111): a lane widening into two, a road carried on across a
 * gap, a turn drawn without a junction round it. A junction paves its connectors; these had none, the ground showing
 * between the lanes they join. Each is paved as an automatic junction paves its own (`connectorBands`: as wide as its
 * lanes, with a stub of each road lane it leaves and joins), and where two or more share a lane's end (a lane fanning
 * out into two, two merging), the slivers between them are paved too (as a junction's "Fill holes" does: gaps under
 * FILL_GAP). Not a link's (a link has its own surface). Drawn only: the lanes, connectors and cars don't change.
 * Framework-free.
 */
import { fillLoops } from "./junction-fill";
import { LastFew, boxOf, connectorBands, connectorLevel, laneById, laneLength, type Band, type Box, type JunctionContents, type Pt, type Sketch, type SketchConnector, type SketchLane } from "./lane-sketch";

/** connectors on no junction sharing lanes (leaving or joining one), on one level */
export interface LooseSurface {
  connectors: string[];
  /** the connectors' bands, with their stubs */
  bands: Band[];
  /** the ground between them to pave too, as loops (fill them nonzero); none for a connector alone */
  fill: Pt[][];
  level: number;
  /** round the bands and the fill (m) */
  box: Box;
}

const kept = new LastFew<Sketch, LooseSurface[]>();
/** a connector's surface, and the lanes it was worked out from */
interface Item { c: SketchConnector; from: SketchLane | undefined; to: SketchLane | undefined; bands: Band[]; box: Box; level: number; /** the lane ends it leaves and joins (grouped by) */ ends: string[] }
// (each connector's, kept while it and its lanes are the same objects: an edit changes a few, and a drag redraws each frame)
let itemsKept = new Map<string, Item>();
// (a group's fill, kept while its connectors and the lanes they join are the same objects: a drag changes a few)
let fillKept = new Map<string, { deps: object[]; fill: Pt[][] }>();

/** the connectors on no junction (`contents`: every junction's, as contentsOf gives them) nor link, grouped, their surfaces */
export function looseSurfaces(sk: Sketch, contents: Map<string, JunctionContents>): LooseSurface[] {
  const was = kept.get(sk);
  if (was) return was;
  const onJunction = new Set<string>();
  for (const c of contents.values()) for (const id of c.connectors) onJunction.add(id);
  for (const k of sk.links ?? []) for (const id of k.conns) onJunction.add(id);
  const items: Item[] = [], nextItems = new Map<string, Item>();
  for (const c of sk.connectors) {
    if (onJunction.has(c.id)) continue;
    const from = laneById(sk, c.from.lane), to = laneById(sk, c.to.lane), had = itemsKept.get(c.id);
    let it: Item | null = had && had.c === c && had.from === from && had.to === to ? had : null;
    if (!it) {
      const bands = connectorBands(sk, c);
      if (!bands.length) continue;
      const w = Math.max(...bands.map(b => Math.max(b.width, b.w1 ?? 0)));
      const level = connectorLevel(sk, c), end = (e: SketchConnector["from"], l: SketchLane | undefined) => `${level}:${e.lane}:${l && e.s > laneLength(l.shape) / 2 ? "end" : "start"}`;
      it = { c, from, to, bands, box: boxOf(bands.flatMap(b => b.pts), w / 2), level, ends: [end(c.from, from), end(c.to, to)] };
    }
    items.push(it); nextItems.set(c.id, it);
  }
  itemsKept = nextItems;
  // grouped: those sharing a lane's end (leaving it, or joining it, at the same end: a lane fanning out, two merging, a
  // road widening), on the same level. (Not by nearness: the two sides of a narrow median would be paved across; nor
  // by lane only: a road's pieces joined one to the next would make one group of the whole road.)
  const parent = items.map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const byLane = new Map<string, number>();
  items.forEach((it, i) => {
    for (const key of it.ends) { const j = byLane.get(key); if (j === undefined) byLane.set(key, i); else parent[root(i)] = root(j); }
  });
  const groups = new Map<number, Item[]>();
  items.forEach((it, i) => { const r = root(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(it); });
  const out: LooseSurface[] = [], nextFills = new Map<string, { deps: object[]; fill: Pt[][] }>();
  for (const g of groups.values()) {
    const bands = g.flatMap(x => x.bands);
    let fill: Pt[][] = [];
    if (g.length > 1) {
      const key = g.map(x => x.c.id).sort().join(" ");
      const deps: object[] = g.flatMap(x => [x.c, x.from ?? {}, x.to ?? {}]);
      const had = fillKept.get(key);
      fill = had && had.deps.length === deps.length && had.deps.every((d, i) => d === deps[i]) ? had.fill : fillLoops(bands, []);
      nextFills.set(key, { deps, fill });
    }
    const box = g.map(x => x.box).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
    out.push({ connectors: g.map(x => x.c.id), bands, fill, level: g[0].level, box });
  }
  // (only the groups there now kept: no growing with every edit)
  fillKept = nextFills;
  kept.set(sk, out);
  return out;
}
