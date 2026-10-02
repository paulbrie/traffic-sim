"use client";

import { useSubject } from "subjecto/react";
import { network$, stats$ } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { junctionRefs } from "@/engine/refs";
import type { Compiled } from "@/engine/compile";
import type { BuildingUse, Control, LinkDef, Network } from "@/engine/types";

/** what the pointer is over in the 3D view */
export type Hovered = { kind: "vehicle" | "node" | "building" | "link" | "marker"; id: string };

const CONTROL: Record<Control, string> = { priority: "Priority (give way)", free: "Free flow", stop: "Stop signs", lights: "Traffic lights", roundabout: "Roundabout" };
const USE: Record<BuildingUse, string> = { home: "Homes", shop: "Shops", office: "Offices", industry: "Industry", school: "School", civic: "Public building", other: "Other", minor: "Outbuilding" };

/**
 * A card by the pointer in the 3D view with what it is over: a road, a junction, a building, a marker or a
 * vehicle, and how traffic is there right now (~4×/s).
 */
export function HoverInfo({ at, x, y }: { at: Hovered; x: number; y: number }) {
  useSubject(stats$);
  const [net] = useSubject(network$);
  const c = simController.compiled;
  const info = describe(at, net, c);
  if (!info) return null;
  return (
    <div className="pointer-events-none absolute z-20 max-w-64 rounded-lg border bg-background/95 px-2.5 py-1.5 text-[11px] leading-snug shadow-md backdrop-blur"
      style={{ left: x + 14, top: y + 14 }}>
      <div className="font-medium">{info.title}</div>
      {info.sub && <div className="text-muted-foreground">{info.sub}</div>}
      {info.rows.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {info.rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="text-right tabular-nums">{v}</dd></div>)}
        </dl>
      )}
    </div>
  );
}

type Info = { title: string; sub?: string; rows: [string, string][] };
const kmh = (ms: number) => `${Math.round(ms * 3.6)} km/h`;

function describe(at: Hovered, net: Network, c: Compiled): Info | null {
  const sim = simController.sim;
  if (at.kind === "link") {
    const l = net.links.find(x => x.id === at.id);
    if (!l) return null;
    const ef = c.edgeByKey.get(`${l.id}:1`), eb = c.edgeByKey.get(`${l.id}:-1`), len = (ef ?? eb)?.length ?? 0;
    const rows: [string, string][] = [
      ["Lanes", lanes(l)],
      ["Speed limit", `${l.speed} km/h`],
      ["Length", len >= 1000 ? `${(len / 1000).toFixed(2)} km` : `${Math.round(len)} m`],
    ];
    if (sim) {
      // vehicles on it now (both ways) and how fast they go
      let n = 0, sp = 0;
      for (const e of [ef, eb]) if (e) for (const lp of e.lanes) { const st = sim.laneStats(lp.id); n += st.vehicles; sp += st.vehicles * st.speed; }
      rows.push(["Vehicles now", String(n)]);
      if (n) rows.push(["Average speed", kmh(sp / n)]);
      if (l.counter) {
        const f = sim.counter(l.id, 1), b = sim.counter(l.id, -1);
        rows.push(["Counted", `${(f?.total ?? 0) + (b?.total ?? 0)} (${Math.round((f?.perHour ?? 0) + (b?.perHour ?? 0))}/h)`]);
      }
    }
    return { title: l.name || "Unnamed road", sub: l.rev ? "Has a reversible lane" : undefined, rows };
  }
  if (at.kind === "node") {
    const n = net.nodes.find(x => x.id === at.id), cn = c.nodeById.get(at.id);
    if (!n || !cn) return null;
    const ref = junctionRefs(c).get(n.id), roads = net.links.filter(l => l.from === n.id || l.to === n.id).map(l => l.name).filter(Boolean);
    const rows: [string, string][] = [["Roads", String(cn.degree)]];
    if (sim && cn.degree >= 3) {
      const st = sim.junctionStats(cn.idx);
      rows.push(["Vehicles/min", st.perMin.toFixed(1)], ["Crossed", String(st.through)], ["Waiting now", String(st.waiting)]);
    }
    const names = [...new Set(roads)].slice(0, 3).join(" · ");
    return { title: `${ref ? `${ref} · ` : ""}${cn.degree >= 3 || n.control === "roundabout" ? CONTROL[n.control] : cn.degree === 1 ? "Road end" : "Road point"}`, sub: names || undefined, rows };
  }
  if (at.kind === "building") {
    const b = net.buildings?.find(x => x.id === at.id);
    if (!b) return null;
    const area = Math.abs(b.pts.reduce((s, p, i) => { const q = b.pts[(i + 1) % b.pts.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
    const floors = Math.max(1, Math.round(b.height / 3));
    return {
      title: b.name || USE[b.use], sub: b.name ? USE[b.use] : undefined,
      rows: [["Height", `${Math.round(b.height)} m · ${floors} floor${floors === 1 ? "" : "s"}`], ["Footprint", `${Math.round(area)} m²`], ["Floor area", `${Math.round(area * floors)} m²`],
        ...(b.trips === 0 ? [["Traffic", "none"] as [string, string]] : [])],
    };
  }
  if (at.kind === "marker") {
    const m = net.markers?.find(x => x.id === at.id);
    return m ? { title: m.label || "Marker", sub: "Marker", rows: [] } : null;
  }
  const v = sim?.vehicles.find(x => String(x.id) === at.id);
  if (!v) return null;
  return { title: `${v.kind === "car" ? "Car" : v.kind === "truck" ? "Truck" : "Bus"} #${v.id}`, sub: v.state, rows: [["Speed", kmh(v.v)], ["Wants", kmh(v.v0)]] };
}

function lanes(l: LinkDef) {
  if (l.lanesF && l.lanesB) return `${l.lanesF} + ${l.lanesB} (two-way)`;
  return `${l.lanesF || l.lanesB} (one-way)`;
}
