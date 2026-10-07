"use client";

import { Fragment } from "react";
import { junctionRefs } from "@/engine/refs";
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

/** a message with the ids in it as links: a click selects the thing and brings it into view */
export function LinkedText({ text }: { text: string }) {
  const parts: (string | { token: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(ID)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push({ token: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) => typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : (
        <button key={i} type="button" className="font-mono text-[0.95em] underline decoration-dotted underline-offset-2 hover:text-foreground hover:decoration-solid"
          title={`Select ${p.token} and go to it`}
          onClick={e => {
            e.stopPropagation();
            const r = resolve(p.token);
            if (!r) return;
            select(r.sel);
            if (r.at) sendView("focus", r.at.x, r.at.y);
          }}>{p.token}</button>
      ))}
    </>
  );
}
