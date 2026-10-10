/**
 * A road's lanes one by one: a lane deleted (the road keeping the rest; side by side, laid out again from the lead
 * lane, the next one the lead if it was; its last lane: the road goes), or taken out of its road (kept, in no road, with
 * the road's speed limit as its own). And,
 * on any delete, what named a lane or road that is gone let go: journeys from or to it, turning shares from or to it.
 * Framework-free; the caller settles the sketch (the roads side by side laid out again).
 */
import { remove, type Sketch } from "./lane-sketch";

/** journeys and turning shares naming lanes or roads that are no longer in the sketch let go (the sketch as it was if none) */
export function dropDangling(sk: Sketch): Sketch {
  const lanes = new Set(sk.lanes.map(l => l.id)), roads = new Set(sk.roads.map(r => r.id));
  // (a turning share's way: a road's id, or `lane:<id>` for a lane in no road)
  const way = (k: string) => (k.startsWith("lane:") ? lanes.has(k.slice(5)) : roads.has(k));
  const journeys = sk.journeys?.filter(j => lanes.has(j.from) && lanes.has(j.to));
  let changed = !!sk.journeys && journeys!.length !== sk.journeys.length;
  const junctions = sk.junctions.map(j => {
    if (!j.splits?.length) return j;
    const splits = j.splits.filter(s => way(s.from)).map(s => {
      const keep = Object.entries(s.shares).filter(([k]) => way(k));
      return keep.length === Object.keys(s.shares).length ? s : { ...s, shares: Object.fromEntries(keep) };
    }).filter(s => Object.keys(s.shares).length);
    if (splits.length === j.splits.length && splits.every((s, i) => s === j.splits![i])) return j;
    changed = true;
    const { splits: _, ...rest } = j;
    return splits.length ? { ...rest, splits } : rest;
  });
  if (!changed) return sk;
  const { journeys: _j, ...rest } = sk;
  return { ...rest, junctions, ...(journeys?.length ? { journeys } : {}) };
}

/** lanes deleted, with their connectors and what named them; and the roads that went with them (their last lane) */
export function deleteLanes(sk: Sketch, ids: string[]): { sketch: Sketch; roadsGone: string[] } {
  const set = new Set(ids);
  const roadsGone = sk.roads.filter(r => r.lanes.length && r.lanes.every(l => set.has(l))).map(r => r.name);
  return { sketch: dropDangling(remove(sk, { lanes: ids })), roadsGone };
}

/**
 * A side-by-side road with lanes taken out, the others where they were (not packed again, as a delete does: the lane
 * taken out stays where it is, and they would be drawn over it): its offsets kept, from a new lead if the lead went
 * (the offsets then from it, and turned over if it runs the other way).
 */
function keepPlaces(road: Sketch["roads"][number], was: Sketch["roads"][number]): Sketch["roads"][number] {
  const al = was.align;
  if (!al || !road.lanes.length) return road;
  const all = [{ id: al.ref, offset: 0, reverse: false }, ...al.lanes].filter(x => road.lanes.includes(x.id));
  const ref = all.find(x => x.id === al.ref) ?? all[0];
  if (!ref) return road;
  const flip = ref.reverse ? -1 : 1;
  return { ...road, align: { ref: ref.id, lanes: all.filter(x => x !== ref).map(x => ({ id: x.id, offset: Number(((x.offset - ref.offset) * flip).toFixed(3)), reverse: x.reverse !== ref.reverse })) } };
}

/** lanes taken out of their roads, kept as lanes in no road (a road left with none goes); the roads that went */
export function takeOutOfRoad(sk: Sketch, ids: string[]): { sketch: Sketch; roadsGone: string[] } {
  const set = new Set(ids);
  if (!sk.roads.some(r => r.lanes.some(l => set.has(l)))) return { sketch: sk, roadsGone: [] };
  const roadsGone = sk.roads.filter(r => r.lanes.length && r.lanes.every(l => set.has(l))).map(r => r.name);
  const roads = sk.roads.map(r => (r.lanes.some(l => set.has(l)) ? keepPlaces({ ...r, lanes: r.lanes.filter(l => !set.has(l)) }, r) : r)).filter(r => r.lanes.length);
  // (each keeps its road's speed limit as its own: a lane in no road has its own)
  const speedOf = new Map(sk.roads.flatMap(r => (r.speed !== undefined ? r.lanes.filter(l => set.has(l)).map(l => [l, r.speed!] as const) : [])));
  const lanes = speedOf.size ? sk.lanes.map(l => (speedOf.has(l.id) && l.speed === undefined ? { ...l, speed: speedOf.get(l.id)! } : l)) : sk.lanes;
  // (a road gone: turning shares by its id let go)
  return { sketch: dropDangling({ ...sk, lanes, roads }), roadsGone };
}
