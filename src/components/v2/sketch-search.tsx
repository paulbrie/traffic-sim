"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { isFullCircle, laneLength, type JunctionContents, type Sketch } from "@/lib/lane-sketch";

/** what a search entry leads to: something on the sketch, or a car running now */
export type SearchTarget = { kind: "road" | "lane" | "connector" | "junction" | "link" | "crossing"; id: string } | { kind: "car"; id: number };
/** one thing on the sketch the search can find */
interface Item { kind: string; title: string; sub: string; id: string; to: SearchTarget; hay: string }

const MAX = 60;
const fmt = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(m < 10 ? 1 : 0)} m`);

/** everything on the sketch (and the cars running now), as search entries */
function catalogue(sk: Sketch, contents: Map<string, JunctionContents>, cars: { id: number; edge?: string; kmh?: number }[]): Item[] {
  const out: Item[] = [];
  const add = (kind: string, title: string, sub: string, id: string, to: SearchTarget) => out.push({ kind, title, sub, id, to, hay: `${kind} ${title} ${sub} ${id}`.toLowerCase() });
  const roadOf = new Map(sk.roads.flatMap(r => r.lanes.map(id => [id, r] as const)));
  const junctionsOf = new Map<string, string[]>(), junctionOfLane = new Map<string, string>(), junctionOfConn = new Map<string, string>();
  for (const j of sk.junctions) {
    const c = contents.get(j.id);
    for (const r of c?.roads ?? []) junctionsOf.set(r, [...(junctionsOf.get(r) ?? []), j.name]);
    for (const id of c?.lanes ?? []) junctionOfLane.set(id, j.name);
    for (const id of c?.connectors ?? []) junctionOfConn.set(id, j.name);
  }
  for (const j of sk.junctions) {
    const c = contents.get(j.id), roads = [...new Set((c?.roads ?? []).map(id => sk.roads.find(r => r.id === id)?.name ?? id))];
    add("Junction", j.name, [j.lights ? "lights" : "", roads.length ? roads.join(", ") : `${c?.connectors.length ?? 0} connectors`].filter(Boolean).join(" · "), j.id, { kind: "junction", id: j.id });
  }
  for (const r of sk.roads) add("Road", r.name, `${r.lanes.length} lane${r.lanes.length === 1 ? "" : "s"}${junctionsOf.get(r.id)?.length ? ` · joined at ${junctionsOf.get(r.id)!.join(", ")}` : ""}`, r.id, { kind: "road", id: r.id });
  for (const l of sk.lanes) {
    const r = roadOf.get(l.id), j = junctionOfLane.get(l.id);
    add("Lane", r ? `${l.id} · ${r.name}` : l.id, [isFullCircle(l.shape) ? "ring" : "", fmt(laneLength(l.shape)), r ? "" : j ? `on ${j}` : "in no road", l.control ?? ""].filter(Boolean).join(" · "), l.id, { kind: "lane", id: l.id });
  }
  for (const c of sk.connectors) {
    const a = roadOf.get(c.from.lane)?.name, b = roadOf.get(c.to.lane)?.name, j = junctionOfConn.get(c.id);
    add("Connector", `${c.from.lane}${a ? ` (${a})` : ""} → ${c.to.lane}${b ? ` (${b})` : ""}`, [j ? `on ${j}` : "", c.straight ? "straight" : "", c.via?.length ? `${c.via.length} bend${c.via.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "), c.id, { kind: "connector", id: c.id });
  }
  for (const k of sk.links ?? []) {
    const n = (id: string) => sk.roads.find(r => r.id === id)?.name ?? id;
    add("Link", `${n(k.a.road)} ↔ ${n(k.b.road)}`, `${k.conns.length} connectors`, k.id, { kind: "link", id: k.id });
  }
  for (const x of sk.crossings ?? []) add("Zebra crossing", x.id, `${x.peds} pedestrians / h`, x.id, { kind: "crossing", id: x.id });
  for (const v of cars) add("Car", `#${v.id}`, [v.edge ?? "", v.kmh !== undefined ? `${Math.round(v.kmh)} km/h` : ""].filter(Boolean).join(" · "), String(v.id), { kind: "car", id: v.id });
  return out;
}

/** the entries matching every word typed, best first: an exact id or name, then those starting with it */
function search(items: Item[], q: string): Item[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  // (a car by #number: its number alone matches too)
  const ql = q.trim().toLowerCase().replace(/^#/, ""), hits: { it: Item; score: number }[] = [];
  for (const it of items) {
    if (!words.every(w => it.hay.includes(w.replace(/^#(?=\d)/, "")) || it.hay.includes(w))) continue;
    const t = it.title.toLowerCase().replace(/^#/, ""), id = it.id.toLowerCase();
    const score = id === ql || t === ql ? 0 : t.startsWith(ql) || id.startsWith(ql) ? 1 : 2;
    hits.push({ it, score });
    if (hits.length > 5000) break;
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, MAX).map(h => h.it);
}

/**
 * Cmd/Ctrl+K in the V2 editor, as V1's search: a bar over the map finding anything on the sketch — roads,
 * junctions, lanes, connectors, links, zebra crossings, and the cars running now. Enter (or a click) selects
 * it and brings it into view. Mounted only while open: a fresh box each time, with the sketch as it is then.
 */
export function SketchSearch({ sketch, contents, cars, onGo, onClose }: {
  sketch: Sketch; contents: Map<string, JunctionContents>; cars: { id: number; edge?: string; kmh?: number }[];
  onGo: (to: SearchTarget) => void; onClose: () => void;
}) {
  const [q, setQ] = useState(""), [at, setAt] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => catalogue(sketch, contents, cars), []);
  const hits = useMemo(() => search(items, q), [items, q]);
  const go = (it: Item) => { onGo(it.to); onClose(); };
  const onKey = (e: React.KeyboardEvent) => {
    // (keys typed here are the box's, not the editor's: no tool picked, nothing deleted)
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setAt(i => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && hits[at]) { e.preventDefault(); go(hits[at]); }
  };
  return (
    <div className="absolute inset-0 z-30 flex justify-center bg-background/30 pt-6" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex h-fit max-h-[70%] w-[min(680px,calc(100%-2rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-lg" role="dialog" aria-label="Search the sketch">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <input autoFocus value={q} onChange={e => { setQ(e.target.value); setAt(0); }} onKeyDown={onKey}
            placeholder="Search roads, junctions, lanes (l12), connectors, crossings, cars (#123)…" aria-label="Search the sketch"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          <Kbd>Esc</Kbd>
        </div>
        <div className="min-h-0 overflow-y-auto" role="listbox">
          {hits.map((it, i) => (
            <button key={`${it.kind}:${it.id}`} type="button" role="option" aria-selected={i === at}
              className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm ${i === at ? "bg-muted" : "hover:bg-muted/60"}`}
              onMouseEnter={() => setAt(i)} onClick={() => go(it)}>
              <span className="w-28 shrink-0 text-[11px] font-medium text-muted-foreground uppercase">{it.kind}</span>
              <span className="min-w-0 flex-1 truncate">{it.title}</span>
              <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground" title={`${it.sub} · ${it.id}`}>{it.sub}{it.sub ? " · " : ""}<span className="font-mono">{it.id}</span></span>
            </button>
          ))}
          {q.trim() && !hits.length && <p className="px-3 py-3 text-sm text-muted-foreground">Nothing on the sketch matches “{q}”.</p>}
          {!q.trim() && <p className="px-3 py-3 text-xs text-muted-foreground">Type a name or an id: every word must match. ↑ ↓ to choose, Enter to select it and go there.</p>}
        </div>
      </div>
    </div>
  );
}
