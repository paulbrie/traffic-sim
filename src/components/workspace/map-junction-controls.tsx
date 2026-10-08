"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import type { CNode, Edge } from "@/engine/compile";
import { isJunction } from "@/engine/refs";
import type { ApproachSign, Control, Vec } from "@/engine/types";
import { commit, network$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { viewport } from "@/state/commands";
import { junctionOf, setJunctionControl } from "@/state/junctions";
import * as ops from "@/state/ops";
import { cn } from "@/lib/utils";
import { SignGlyph } from "./lane-arrows";

const CONTROLS: { value: Control; label: string }[] = [
  { value: "priority", label: "Priority" }, { value: "stop", label: "All-way stop" }, { value: "lights", label: "Lights" },
  { value: "roundabout", label: "Roundabout" }, { value: "free", label: "Free" },
];
const SIGNS: { value: ApproachSign | null; label: string }[] = [
  { value: null, label: "Priority road (no sign)" }, { value: "yield", label: "Give way" }, { value: "stop", label: "Stop" },
];
/** below this zoom (px per m) the signs by the roads are left out: they would cover the junction */
const MIN_SCALE = 1.6;

/** where the camera is (as the plan view last drew it), and the overlay's size */
interface Cam { cx: number; cy: number; scale: number; w: number; h: number }

/** the camera, followed frame by frame while the controls show (the plan view draws on its own canvas) */
function useCamera(on: boolean, box: React.RefObject<HTMLDivElement | null>): Cam | null {
  const [cam, setCam] = useState<Cam | null>(null);
  useEffect(() => {
    if (!on) return;
    let raf = 0, last = "";
    const tick = () => {
      const el = box.current;
      if (el && el.clientWidth && viewport.wm) {
        const c = { cx: viewport.cx, cy: viewport.cy, scale: el.clientWidth / viewport.wm, w: el.clientWidth, h: el.clientHeight };
        const k = `${c.cx.toFixed(2)},${c.cy.toFixed(2)},${c.scale.toFixed(4)},${c.w},${c.h}`;
        if (k !== last) { last = k; setCam(c); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on, box]);
  return on ? cam : null;
}

/** the priority road sign: a yellow diamond in a white one */
function PriorityGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="size-4" aria-hidden>
      <path d="M10 1 19 10 10 19 1 10Z" fill="#fff" stroke="#333" strokeWidth="0.8" />
      <path d="M10 4.5 15.5 10 10 15.5 4.5 10Z" fill="#f2c200" />
    </svg>
  );
}

/** beside the kerb, a few metres before the line where a road arrives at the junction */
function besideKerb(e: Edge): Vec | null {
  const lp = e.lanes[e.n - 1];
  if (!lp) return null;
  const s = Math.max(0, lp.len - 6), p = lp.poly.at(s), t = lp.poly.tangent(s), off = e.lw / 2 + 2.6;
  return { x: p.x - t.y * off, y: p.y + t.x * off };
}

/**
 * On the 2D map, for the junction selected (or the junctions at the ends of the road selected, with its signs): how it is controlled (by its middle), and at a priority junction
 * the sign on each road arriving (beside its kerb, before the line): none (it has priority), give way or stop.
 * One click sets either; undo takes it back.
 */
export function MapJunctionControls() {
  const [sel] = useDeepSubject(ui, "selection");
  const [readOnly] = useDeepSubject(ui, "readOnly");
  const [tool] = useDeepSubject(ui, "tool");
  const [net] = useSubject(network$);
  const box = useRef<HTMLDivElement>(null);
  const c = simController.compiled;
  // the junctions to set: the one selected, or those at the ends of the road selected (with only its own signs)
  const targets: { lead: CNode; members: CNode[]; arriving: Edge[] }[] = [];
  const add = (n: CNode | undefined, only?: string) => {
    if (!n || !isJunction(n)) return;
    const lead = n.lead ?? n;
    if (targets.some(t => t.lead === lead)) return;
    const members = lead.handNodes ?? (lead.cluster.length ? lead.cluster : [lead]);
    const arriving = members.flatMap(k => k.arms.filter(a => a.inEdge && (!only || a.link.id === only))).map(a => a.inEdge!);
    targets.push({ lead, members, arriving });
  };
  if (sel?.kind === "node") add(c.nodeById.get(sel.id));
  else if (sel?.kind === "link") { const l = ops.linkById(net, sel.id); if (l) { add(c.nodeById.get(l.from), l.id); add(c.nodeById.get(l.to), l.id); } }
  // (not while drawing roads: the controls would be in the way of the clicks)
  const show = targets.length > 0 && !readOnly && tool !== "road";
  const cam = useCamera(show, box);
  // TEMP (diagnostics, to remove): what the controls see, in the dev server's log
  const why = `v2 ${sel?.kind}:${sel?.id} targets=${targets.length} readOnly=${readOnly} tool=${tool} cam=${cam ? `${cam.w}x${cam.h}@${cam.scale.toFixed(2)}` : "none"} lines=${sel?.kind === "node" ? (() => { const n = c.nodeById.get(sel.id), lead = n?.lead ?? n; return lead?.handNodes ? `hand ${lead.def.id} markings=${lead.def.markings ?? "dashed"}` : `node degree ${n?.degree}`; })() : "-"}`;
  useEffect(() => { if (sel) console.warn("[junction-controls]", why); }, [why, sel]);
  if (!show) return <div ref={box} className="pointer-events-none absolute inset-0" />;

  const at = (p: Vec) => (cam ? { left: (p.x - cam.cx) * cam.scale + cam.w / 2, top: (p.y - cam.cy) * cam.scale + cam.h / 2 } : null);
  const inView = (p: { left: number; top: number } | null) => !!p && cam && p.left > -40 && p.top > -40 && p.left < cam.w + 40 && p.top < cam.h + 40;
  const setSign = (e: Edge, s: ApproachSign | null) => commit(ops.updateLink(net, e.link.id, e.dir === 1 ? { signF: s } : { signB: s }));

  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {targets.map(({ lead, members, arriving }) => {
        const hand = junctionOf(net, lead.def.id);
        // (read from the plan, not the compiled copy: that follows a moment after an edit)
        const control = ops.nodeById(net, lead.def.id)?.control ?? lead.def.control;
        const middle = { x: members.reduce((s, k) => s + k.pos.x, 0) / members.length, y: members.reduce((s, k) => s + k.pos.y, 0) / members.length };
        const setControl = (v: Control) => {
          if (v === control) return;
          if (hand) { if (v !== "roundabout") commit(setJunctionControl(net, hand, v)); return; }
          commit(lead.cluster.reduce((nw, k) => ops.updateNode(nw, k.def.id, { control: v }), ops.updateNode(net, lead.def.id, { control: v })));
        };
        const mid = at(middle);
        // (a roundabout stays one: its own tool builds it; a junction drawn by hand can't become one)
        const choices = CONTROLS.filter(o => o.value === control || (o.value !== "roundabout" && control !== "roundabout"));
        return (
          <Fragment key={lead.def.id}>
            {mid && inView(mid) && (
              <div className="pointer-events-auto absolute flex -translate-x-1/2 translate-y-5 items-center gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-sm backdrop-blur"
                style={mid} role="radiogroup" aria-label="How the junction is controlled" onPointerDown={e => e.stopPropagation()}>
                {choices.map(o => (
                  <button key={o.value} type="button" role="radio" aria-checked={o.value === control} title={o.label}
                    className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", o.value === control ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                    onClick={() => setControl(o.value)}>{o.label}</button>
                ))}
              </div>
            )}
            {control === "priority" && cam && cam.scale >= MIN_SCALE && arriving.map(e => {
              const p = besideKerb(e), q = p && at(p);
              if (!q || !inView(q)) return null;
              const l = ops.linkById(net, e.link.id) ?? e.link, sign = (e.dir === 1 ? l.signF : l.signB) ?? null;
              return (
                <div key={e.key} className="pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-sm backdrop-blur"
                  style={q} role="radiogroup" aria-label={`Sign on ${e.link.name || e.link.id}`} onPointerDown={ev => ev.stopPropagation()}>
                  {SIGNS.map(o => (
                    <button key={o.value ?? "none"} type="button" role="radio" aria-checked={o.value === sign} title={`${e.link.name || e.link.id}: ${o.label}`}
                      className={cn("grid size-6 place-items-center rounded", o.value === sign ? "bg-primary/15 ring-1 ring-primary" : "opacity-60 hover:bg-muted hover:opacity-100")}
                      onClick={() => setSign(e, o.value)}>
                      {o.value ? <SignGlyph kind={o.value} className="size-4" /> : <PriorityGlyph />}
                    </button>
                  ))}
                </div>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}
