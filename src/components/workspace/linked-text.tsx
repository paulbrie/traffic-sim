"use client";

import { Fragment, type ReactNode } from "react";
import { junctionRefs } from "@/engine/refs";
import type { Compiled } from "@/engine/compile";
import type { Vec } from "@/engine/types";
import { network$, select, type Selection } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { sendView } from "@/state/commands";

// ids as they appear in messages: points, roads, parking rows, crossings, and junction names (J12)
const ID = /\b(n_[a-z0-9]+|l_[a-z0-9]+|pk_[a-z0-9]+|x_[a-z0-9_]+|J\d+)\b/gi;

/** what an id in a message stands for, where it is, and the points it spans (null: not on the plan any more) */
export function resolve(token: string): { sel: Selection; at: Vec | null; pts: Vec[] } | null {
  const net = network$.getValue(), c = simController.compiled;
  let id = token;
  if (/^J\d+$/i.test(token)) { const hit = [...junctionRefs(c)].find(([, r]) => r.toLowerCase() === token.toLowerCase()); if (!hit) return null; id = hit[0]; }
  const one = (sel: Selection, at: Vec) => ({ sel, at, pts: [at] });
  if (id.startsWith("n_")) { const n = c.nodeById.get(id); return n ? one({ kind: "node", id }, n.pos) : null; }
  if (id.startsWith("l_")) {
    if (!net.links.some(l => l.id === id)) return null;
    const e = c.edges.find(x => x.link.id === id);
    const pts = e ? [0, 0.25, 0.5, 0.75, 1].map(f => e.center.at(e.center.len * f)) : [];
    return { sel: { kind: "link", id }, at: pts[2] ?? null, pts };
  }
  if (id.startsWith("pk_")) { const p = net.parking?.find(x => x.id === id); return p ? { sel: { kind: "parking", id }, at: { x: (p.line.a.x + p.line.b.x) / 2, y: (p.line.a.y + p.line.b.y) / 2 }, pts: [p.line.a, p.line.b] } : null; }
  if (id.startsWith("x_")) { const x = net.crossings?.find(y => y.id === id); return x ? { sel: { kind: "crossing", id }, at: { x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 }, pts: [x.a, x.b] } : null; }
  return null;
}

/** where a road, junction point or stop is (null: not on the plan any more) */
function place(sel: Selection): Vec | null {
  if (sel.kind === "node") return simController.compiled.nodeById.get(sel.id)?.pos ?? null;
  if (sel.kind === "link") return resolve(sel.id)?.at ?? null;
  if (sel.kind === "stop") {
    const st = network$.getValue().stops.find(x => x.id === sel.id), e = st && simController.compiled.edges.find(x => x.link.id === st.link);
    return e ? e.center.at(e.center.len * st.pos) : null;
  }
  return null;
}

/** selects the thing and brings it into view */
function go(sel: Selection, at: Vec | null) {
  select(sel);
  if (at) sendView("focus", at.x, at.y);
}

const LINK = "underline decoration-dotted underline-offset-2 hover:text-foreground hover:decoration-solid";

/** a road, junction or stop by name, as a link: a click selects it and brings it into view */
export function PlaceLink({ sel, children, className }: { sel: Selection; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={`${LINK} text-right ${className ?? ""}`} title="Select it and go to it"
      onClick={e => { e.stopPropagation(); go(sel, place(sel)); }}>{children}</button>
  );
}

/**
 * The names of the roads at a junction (and the points of its cluster), each to its road's id: what a junction event
 * ("enter L from Strada X lane 1 to Strada Y lane 2") names, for `LinkedText`
 */
export function roadNamesAt(node: string | undefined): Map<string, string> | undefined {
  const c = simController.compiled, n = node ? c.nodeById.get(node) : undefined;
  if (!n) return undefined;
  // (kept while the plan compiled stays the same: the logs ask for them a few times a second)
  let byNode = namesCache.get(c);
  if (!byNode) namesCache.set(c, (byNode = new Map()));
  let out = byNode.get(n.def.id);
  if (!out) {
    out = new Map();
    for (const m of [n, ...n.cluster]) for (const a of m.arms) if (a.link.name && !out.has(a.link.name)) out.set(a.link.name, a.link.id);
    byNode.set(n.def.id, out);
  }
  return out;
}
const namesCache = new WeakMap<Compiled, Map<string, Map<string, string>>>();

const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * a message with the ids in it as links: a click selects the thing and brings it into view; `names` (a road's name
 * to its id): those names too, shown as they are
 */
export function LinkedText({ text, names }: { text: string; names?: Map<string, string> }) {
  const parts: (string | { token: string; label: string })[] = [];
  // (the longer names first, so "Strada Mare" isn't taken for "Strada")
  const lower = names && new Map([...names].map(([k, v]) => [k.toLowerCase(), v]));
  const named = names?.size ? [...names.keys()].sort((a, b) => b.length - a.length).map(escape).join("|") : "";
  const re = named ? new RegExp(`${ID.source}|(?<![\\p{L}\\p{N}])(?:${named})(?![\\p{L}\\p{N}])`, "giu") : ID;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push({ token: lower?.get(m[0].toLowerCase()) ?? m[0], label: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) => typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : (
        <button key={i} type="button" className={p.label === p.token ? `font-mono text-[0.95em] ${LINK}` : LINK}
          title={`Select ${p.label} and go to it`}
          onClick={e => {
            e.stopPropagation();
            const r = resolve(p.token);
            if (r) go(r.sel, r.at);
          }}>{p.label}</button>
      ))}
    </>
  );
}
