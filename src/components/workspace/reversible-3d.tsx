"use client";

import { useSubject } from "subjecto/react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import * as THREE from "three";
import { settings$, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import type { CCorridor, Compiled } from "@/engine/compile";
import { cn } from "@/lib/utils";
import { compass } from "./fields";

/**
 * Over each reversible lane in the 3D view, flying: its live state and three buttons to switch it by hand
 * (open one way, close, open the other way), as the lane panel does. The 3D view moves them every frame
 * (`placeReversibleControls`); they show only near enough to read.
 */
export function ReversibleControls() {
  useSubject(stats$); // live state (~4×/s)
  const [settings] = useSubject(settings$);
  const c = simController.compiled, sim = simController.sim, readOnly = ui.getValue().readOnly;
  return (
    <>
      {c.corridors.map(cor => {
        const live = sim?.rev[cor.idx], hold = settings.revHold?.[cor.def.id] ?? null;
        const [d1, d2] = directions(cor);
        const status = !live ? "Traffic not running" : (["Closed", `Open towards ${d1}`, "Closing…", `Open towards ${d2}`, "Closing…"] as const)[live.state];
        const tone = !live ? "text-muted-foreground" : live.state === 1 || live.state === 3 ? "text-[var(--sig-go)]" : live.state === 0 ? "text-destructive" : "text-amber-600 dark:text-amber-400";
        const btn = (cmd: "1" | "closed" | "2", label: React.ReactNode, title: string) => (
          <button
            type="button" disabled={readOnly} aria-pressed={hold === cmd} title={title}
            onClick={() => simController.reversibleCommand(cor.def.id, hold === cmd ? "auto" : cmd)}
            className={cn("flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:opacity-50",
              hold === cmd ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent")}
          >{label}</button>
        );
        return (
          <div key={cor.def.id} data-rev={cor.def.id}
            className="pointer-events-auto invisible absolute top-0 left-0 z-[6] flex flex-col items-center gap-1 rounded-lg border bg-background/95 px-2 py-1.5 shadow-md backdrop-blur will-change-transform">
            <div className="flex items-baseline gap-1.5 text-[11px] whitespace-nowrap">
              <span className="font-medium">{cor.def.name}</span>
              <span className={tone}>{status}</span>
            </div>
            <div className="flex gap-1" role="group" aria-label={`Switch ${cor.def.name} by hand`}>
              {btn("1", <><ArrowLeft className="size-3" /> {d1}</>, `Open towards ${d1} (by hand; again to hand back)`)}
              {btn("closed", <><X className="size-3" /> Close</>, "Close the lane (by hand; again to hand back)")}
              {btn("2", <>{d2} <ArrowRight className="size-3" /></>, `Open towards ${d2} (by hand; again to hand back)`)}
            </div>
            {/* a stalk down to the road */}
            <span className="absolute top-full left-1/2 h-3 w-px -translate-x-1/2 bg-foreground/50" aria-hidden />
          </div>
        );
      })}
    </>
  );
}

/** direction 1 and 2 of a corridor, as compass points (where each one heads) */
function directions(c: CCorridor): [string, string] {
  const a = c.nodes[0], b = c.nodes[c.nodes.length - 1];
  if (!a || !b) return ["1", "2"];
  return [compass(b.pos.x - a.pos.x, b.pos.y - a.pos.y).name, compass(a.pos.x - b.pos.x, a.pos.y - b.pos.y).name];
}

// the middle of each corridor, worked out once per compiled network
let anchorsFor: Compiled | null = null, anchors = new Map<string, THREE.Vector3>();
function anchorPoints(c: Compiled) {
  if (anchorsFor === c) return anchors;
  anchorsFor = c; anchors = new Map();
  for (const cor of c.corridors) {
    const list = cor.edges[0].length ? cor.edges[0] : cor.edges[1], e = list[Math.floor(list.length / 2)];
    if (!e) continue;
    const p = e.center.at(e.center.len / 2);
    anchors.set(cor.def.id, new THREE.Vector3(p.x, 9, p.y));
  }
  return anchors;
}

const ndc = new THREE.Vector3();
/** put each control over its lane, as seen by `cam` (hidden when off screen, behind, or further than `range` m) */
export function placeReversibleControls(root: HTMLElement | null, cam: THREE.Camera, w: number, h: number, show: boolean, range = 1500) {
  if (!root) return;
  const at = anchorPoints(simController.compiled);
  for (const el of root.querySelectorAll<HTMLElement>("[data-rev]")) {
    const p = at.get(el.dataset.rev!);
    let visible = show && !!p;
    if (p && visible) {
      ndc.copy(p).project(cam);
      visible = ndc.z < 1 && Math.abs(ndc.x) < 1.1 && Math.abs(ndc.y) < 1.1 && cam.position.distanceTo(p) < range;
      // (whole pixels: the cockpit's slight vibration doesn't make it shimmer)
      if (visible) el.style.transform = `translate(${Math.round(((ndc.x + 1) / 2) * w)}px, ${Math.round(((1 - ndc.y) / 2) * h)}px) translate(-50%, calc(-100% - 12px))`;
    }
    const v = visible ? "visible" : "hidden";
    if (el.style.visibility !== v) el.style.visibility = v;
  }
}
