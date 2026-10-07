"use client";

import { useEffect, useMemo, useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { Search } from "lucide-react";
import { connectorId } from "@/engine/compile";
import { isJunction, junctionRefs } from "@/engine/refs";
import type { Vec } from "@/engine/types";
import { connectorsOf } from "@/render/draw2d";
import { network$, select, ui, type Selection } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { sendView } from "@/state/commands";
import { Kbd } from "@/components/ui/kbd";

/** one thing on the plan the search can find */
interface Item { kind: string; title: string; sub: string; id: string; sel: Selection | null; at: Vec | null; hay: string }

const MAX = 60;
const mid = (pts: ArrayLike<number>): Vec | null => {
  const n = pts.length >> 1;
  if (!n) return null;
  const k = (n >> 1) * 2;
  return { x: pts[k], y: pts[k + 1] };
};
const centroid = (pts: Vec[]): Vec | null => (pts.length ? { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length } : null);

/** everything on the plan (and the vehicles running now), as search entries */
function catalogue(): Item[] {
  const net = network$.getValue(), c = simController.compiled, sim = simController.sim, refs = junctionRefs(c), out: Item[] = [];
  const add = (kind: string, title: string, sub: string, id: string, sel: Selection | null, at: Vec | null) =>
    out.push({ kind, title, sub, id, sel, at, hay: `${kind} ${title} ${sub} ${id}`.toLowerCase() });
  const roadName = (id: string) => net.links.find(l => l.id === id)?.name || id;
  for (const n of c.nodes) {
    const ref = refs.get(n.def.id);
    const roads = n.arms.map(a => a.link.name || a.link.id).join(", ");
    if (ref) add("Junction", ref, `${n.def.control} · ${roads}`, n.def.id, { kind: "node", id: n.def.id }, n.pos);
    else add("Point", n.def.id, `${n.gateway ? "entry / exit" : n.degree === 2 ? (isJunction(n) ? "junction" : "joint") : n.degree === 1 ? "dead end" : "point"} · ${roads}`, n.def.id, { kind: "node", id: n.def.id }, n.pos);
  }
  for (const l of net.links) {
    const e = c.edges.find(x => x.link.id === l.id);
    add("Road", l.name || l.id, `${l.lanesF} + ${l.lanesB} lanes${l.level ? ` · level ${l.level}` : ""}`, l.id, { kind: "link", id: l.id }, e ? e.center.at(e.center.len / 2) : null);
  }
  for (const e of c.edges) for (const lp of e.lanes) {
    const id = `${e.link.id}|${e.dir}|${lp.lane}`;
    add("Lane", `${e.link.name || e.link.id} · lane ${lp.lane + 1}`, `${e.dir === 1 ? "as drawn" : "against the drawing"}, ${e.from.def.id} → ${e.to.def.id}`, id, { kind: "lane", id }, lp.poly.at(lp.len / 2));
  }
  for (const v of connectorsOf(c)) {
    const id = connectorId(v), where = refs.get((v.node.lead ?? v.node).def.id) ?? v.node.def.id;
    add("Connector", `${where} · ${v.move.in.link.name || v.move.in.link.id} lane ${v.inLane + 1} → ${v.move.out.link.name || v.move.out.link.id} lane ${v.outLane + 1}`, `${v.move.turn === "S" ? "straight" : v.move.turn === "L" ? "left" : v.move.turn === "R" ? "right" : "U-turn"}`, id, { kind: "connector", id }, mid(v.pts));
  }
  for (const s of net.stops) { const cs = c.stops.find(x => x.def.id === s.id); add("Stop", s.name, `on ${roadName(s.link)}`, s.id, { kind: "stop", id: s.id }, cs ? cs.edge.center.at(Math.min(cs.edge.center.len, cs.s)) : null); }
  for (const l of net.lines) add("Bus line", l.name, `${l.stops.length} stops · ${l.buses} buses`, l.id, { kind: "line", id: l.id }, null);
  for (const x of net.crossings ?? []) add("Zebra crossing", x.id, `${x.peds} pedestrians / h`, x.id, { kind: "crossing", id: x.id }, { x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 });
  for (const p of net.parking ?? []) add("Parking", p.id, `${p.kind} bays · reached from ${roadName(p.link)}`, p.id, { kind: "parking", id: p.id }, { x: (p.line.a.x + p.line.b.x) / 2, y: (p.line.a.y + p.line.b.y) / 2 });
  for (const z of net.zones ?? []) add("Zone", z.name, `${z.members.length} members`, z.id, { kind: "zone", id: z.id }, null);
  for (const m of net.markers ?? []) add("Marker", m.label || m.id, "", m.id, { kind: "marker", id: m.id }, { x: m.x, y: m.y });
  if (sim) for (const v of sim.vehicles) if (!v.dead) add("Vehicle", `#${v.id}`, `${v.kind} · ${v.state}`, String(v.id), { kind: "vehicle", id: String(v.id) }, { x: (v.fx + v.rx) / 2, y: (v.fy + v.ry) / 2 });
  // (buildings last: there can be tens of thousands)
  for (const b of net.buildings ?? []) add("Building", b.name || b.id, b.use, b.id, { kind: "building", id: b.id }, centroid(b.pts));
  return out;
}

/** the entries matching every word typed, best first: an exact id, then titles starting with it */
function search(items: Item[], q: string): Item[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const ql = q.trim().toLowerCase(), hits: { it: Item; score: number }[] = [];
  for (const it of items) {
    if (!words.every(w => it.hay.includes(w))) continue;
    const score = it.id.toLowerCase() === ql || it.title.toLowerCase() === ql ? 0 : it.title.toLowerCase().startsWith(ql) || it.id.toLowerCase().startsWith(ql) ? 1 : 2;
    hits.push({ it, score });
    if (hits.length > 5000) break;
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, MAX).map(h => h.it);
}

/**
 * Cmd/Ctrl+K: a search bar over the map for anything on the plan — roads, junctions and points, lanes, lane
 * connectors, stops, bus lines, crossings, parking, zones, markers, buildings, and the vehicles running now.
 * Enter (or a click) selects it and brings it into view.
 */
export function SearchPalette() {
  const [open] = useDeepSubject(ui, "search");
  // Cmd/Ctrl+K from anywhere on the page, typing included
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); ui.getValue().search = !ui.getValue().search; }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  // (a fresh box each time it opens: empty, with the plan as it is now)
  return open ? <SearchBox /> : null;
}

function SearchBox() {
  useSubject(network$);
  const [q, setQ] = useState(""), [at, setAt] = useState(0);
  const items = useMemo(() => catalogue(), []);
  const hits = useMemo(() => search(items, q), [items, q]);
  const close = () => { ui.getValue().search = false; };
  const go = (it: Item) => {
    if (it.sel) select(it.sel);
    if (it.at) sendView("focus", it.at.x, it.at.y);
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setAt(i => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && hits[at]) { e.preventDefault(); go(hits[at]); }
  };
  return (
    <div className="absolute inset-0 z-30 flex justify-center bg-background/30 pt-6" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="flex h-fit max-h-[70%] w-[min(680px,calc(100%-2rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-lg" role="dialog" aria-label="Search the plan">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <input autoFocus value={q} onChange={e => { setQ(e.target.value); setAt(0); }} onKeyDown={onKey}
            placeholder="Search roads, junctions (J12), lanes, connectors, stops, vehicles (#123)…" aria-label="Search the plan"
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
          {q.trim() && !hits.length && <p className="px-3 py-3 text-sm text-muted-foreground">Nothing on the plan matches “{q}”.</p>}
          {!q.trim() && <p className="px-3 py-3 text-xs text-muted-foreground">Type a name or an id: every word must match. ↑ ↓ to choose, Enter to select it and go there.</p>}
        </div>
      </div>
    </div>
  );
}
