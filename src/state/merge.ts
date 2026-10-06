/**
 * Merging two versions of a plan that both started from the same one (`base`): the one open here
 * (`mine`, with unsaved changes) and the one saved elsewhere meanwhile (`theirs`). Object by object
 * (roads, points, stops, junctions, bays…, by id): what only one side changed is taken from that side;
 * an object both changed keeps this page's version (its owner is looking at it). Framework-free.
 */
import type { Network, PlanSettings } from "@/engine/types";
import type { Underlay } from "@/lib/underlay";

/** the lists of objects with ids that a plan holds (the order of `theirs` is kept, new ones of mine go last) */
const LISTS = ["nodes", "links", "stops", "lines", "signalGroups", "buildings", "flows", "zones", "zoneFlows", "reversibles", "markers", "junctions", "crossings", "parking"] as const;
type ListKey = (typeof LISTS)[number];
type Item = { id: string };

/** changed: not the very same object, and not equal either (a copy read back from the server is equal) */
const changed = (a: unknown, b: unknown) => a !== b && JSON.stringify(a) !== JSON.stringify(b);

/** is their list the same as the base's (remembered: the undo history merges against the same two many times) */
const sameCache = new WeakMap<object, { base: unknown; same: boolean }>();
function same(theirs: Item[] | undefined, base: Item[] | undefined): boolean {
  if (theirs === base) return true;
  if (!theirs) return !changed(theirs, base);
  const c = sameCache.get(theirs);
  if (c && c.base === base) return c.same;
  const v = !changed(theirs, base);
  sameCache.set(theirs, { base, same: v });
  return v;
}

function mergeList(base: Item[] | undefined, mine: Item[] | undefined, theirs: Item[] | undefined): Item[] | undefined {
  if (mine === base) return theirs;
  if (same(theirs, base)) return mine;
  const b = new Map((base ?? []).map(x => [x.id, x])), m = new Map((mine ?? []).map(x => [x.id, x]));
  const out = new Map((theirs ?? []).map(x => [x.id, x]));
  for (const [id, x] of m) if (!b.has(id) || changed(x, b.get(id))) out.set(id, x);            // added or changed here
  for (const id of b.keys()) if (!m.has(id)) out.delete(id);                                      // deleted here
  const list = [...out.values()];
  return list.length || theirs?.length || mine?.length ? list : undefined;
}

export function mergeNetworks(base: Network, mine: Network, theirs: Network): Network {
  if (mine === base) return theirs;
  const out: Record<string, unknown> = { ...theirs };
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    if ((LISTS as readonly string[]).includes(k)) continue;
    const bm = (base as unknown as Record<string, unknown>)[k], mm = (mine as unknown as Record<string, unknown>)[k];
    // (anything else, e.g. the plan's place on Earth or its junction mode: mine where I changed it)
    if (changed(mm, bm)) { if (mm === undefined) delete out[k]; else out[k] = mm; }
  }
  for (const k of LISTS) {
    const v = mergeList(base[k as ListKey] as Item[] | undefined, mine[k as ListKey] as Item[] | undefined, theirs[k as ListKey] as Item[] | undefined);
    if (v === undefined) delete out[k]; else out[k] = v;
  }
  return out as unknown as Network;
}

/** settings: setting by setting, mine where I changed it */
export function mergeSettings(base: PlanSettings, mine: PlanSettings, theirs: PlanSettings): PlanSettings {
  if (mine === base) return theirs;
  const out: Record<string, unknown> = { ...theirs };
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    const bm = (base as unknown as Record<string, unknown>)[k], mm = (mine as unknown as Record<string, unknown>)[k];
    if (changed(mm, bm)) { if (mm === undefined) delete out[k]; else out[k] = mm; }
  }
  return out as unknown as PlanSettings;
}

export function mergeUnderlay(base: Underlay | null, mine: Underlay | null, theirs: Underlay | null): Underlay | null {
  return changed(mine, base) ? mine : theirs;
}
