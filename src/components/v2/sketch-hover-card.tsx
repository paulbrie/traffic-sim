"use client";

/**
 * A card by the pointer on the V2 editor's map with what it is over, as V1's hover card (hover-info.tsx): a lane (its
 * road, length, level, sign, speed limit), a junction (its kind, roads, and how traffic does there while the cars run),
 * a connector, a zebra crossing, or a car (its speed, where it is going, what it waits for). Shown after the pointer
 * rests a moment, not while drawing (see LaneSketch).
 */
import { connectorPts, isFullCircle, laneById, laneLength, speedLimitOf, type JunctionContents, type Sketch } from "@/lib/lane-sketch";
import type { SimStats, SketchSim } from "@/lib/lane-sketch-sim";
import { formatArea, zoneArea } from "@/lib/sketch-zones";

export type HoverHit = { lane: string } | { connector: string } | { junction: string } | { crossing: string } | { link: string } | { zone: string } | { car: number };
export interface HoverInfo { title: string; sub?: string; rows: [string, string][] }

const m = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} km` : `${x.toFixed(x < 10 ? 1 : 0)} m`);
const s = (x: number) => (x < 60 ? `${x.toFixed(x < 10 ? 1 : 0)} s` : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`);

export function describeHover(hit: HoverHit, sk: Sketch, contents: Map<string, JunctionContents>, stats: SimStats | null, car: ReturnType<SketchSim["inspect"]> | null): HoverInfo | null {
  const roadOf = (lane: string) => sk.roads.find(r => r.lanes.includes(lane)) ?? null;
  const all = sk.traffic?.speed ?? 50;
  if ("car" in hit) {
    if (!car) return null;
    return {
      title: `${car.truck ? "Truck" : "Car"} ${car.id}`,
      sub: car.broken !== null ? "broken down" : car.why ? `waiting for ${car.why}` : undefined,
      rows: [
        ["Speed", `${Math.round(car.kmh)} of ${Math.round(car.desiredKmh)} km/h`],
        ["On", car.edge],
        ...(car.leaves ? [["Heading for", "the end of this lane"] as [string, string]] : car.then ? [["Going onto", car.then] as [string, string]] : []),
        ...(car.still >= 1 ? [["Still for", s(car.still)] as [string, string]] : []),
      ],
    };
  }
  if ("lane" in hit) {
    const l = laneById(sk, hit.lane);
    if (!l) return null;
    const r = roadOf(l.id), lim = speedLimitOf(sk, l.id);
    return {
      title: `Lane ${l.id}`, sub: r ? r.name : "in no road",
      rows: [
        ["Length", `${isFullCircle(l.shape) ? "ring · " : ""}${m(laneLength(l.shape))}`],
        ["Speed limit", `${lim ?? all} km/h${lim === undefined ? " (the sketch's)" : ""}`],
        ...(l.level ? [["Level", l.level > 0 ? `+${l.level} (bridge)` : `${l.level} (under)`] as [string, string]] : []),
        ...(l.control ? [["At its end", l.control === "stop" ? "Stop" : "Yield"] as [string, string]] : []),
      ],
    };
  }
  if ("junction" in hit) {
    const j = sk.junctions.find(x => x.id === hit.junction);
    if (!j) return null;
    const c = contents.get(j.id), names = [...new Set((c?.roads ?? []).map(id => sk.roads.find(r => r.id === id)?.name ?? id))];
    const ring = c?.lanes.some(id => { const l = laneById(sk, id); return !!l && isFullCircle(l.shape); });
    const st = stats?.junctions?.find(x => x.id === j.id), t = Math.max(1, stats?.t ?? 0);
    return {
      title: j.name, sub: j.lights ? "traffic lights" : ring ? "roundabout" : "signs or first come",
      rows: [
        ["Roads", names.length ? names.join(", ") : `${c?.connectors.length ?? 0} connectors`],
        ...(st && (st.through || st.queueMax) ? [
          ["Vehicles", `${Math.round((st.through / t) * 3600)} /h`] as [string, string],
          ["Delay each", s(st.through ? st.delay / st.through : st.delay)] as [string, string],
          ["Queue", `${st.queueMean.toFixed(1)} (at most ${st.queueMax})`] as [string, string],
        ] : []),
      ],
    };
  }
  if ("connector" in hit) {
    const c = sk.connectors.find(x => x.id === hit.connector);
    if (!c) return null;
    const pts = connectorPts(sk, c), len = pts ? pts.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0) : 0;
    const on = [...contents].find(([, x]) => x.connectors.includes(c.id))?.[0];
    return {
      title: `Connector ${c.id}`, sub: on ? `on ${sk.junctions.find(j => j.id === on)?.name ?? on}` : undefined,
      rows: [["From", `${c.from.lane}${roadOf(c.from.lane) ? ` (${roadOf(c.from.lane)!.name})` : ""}`], ["To", `${c.to.lane}${roadOf(c.to.lane) ? ` (${roadOf(c.to.lane)!.name})` : ""}`], ["Length", m(len)]],
    };
  }
  if ("crossing" in hit) {
    const x = sk.crossings?.find(y => y.id === hit.crossing);
    return x ? { title: `Zebra crossing ${x.id}`, rows: [["Pedestrians", `${x.peds} /h`], ["Width", m(x.width)]] } : null;
  }
  if ("zone" in hit) {
    const z = sk.zones?.find(x => x.id === hit.zone);
    return z ? { title: z.name, sub: z.note ? (z.note.length > 80 ? `${z.note.slice(0, 80)}…` : z.note) : undefined, rows: [["Area", formatArea(zoneArea(z.outline))]] } : null;
  }
  if ("link" in hit) {
    const k = sk.links?.find(x => x.id === hit.link);
    const n = (id: string) => sk.roads.find(r => r.id === id)?.name ?? id;
    return k ? { title: `Link ${k.id}`, sub: `${n(k.a.road)} ↔ ${n(k.b.road)}`, rows: [["Connectors", String(k.conns.length)]] } : null;
  }
  return null;
}

export function SketchHoverCard({ info, x, y }: { info: HoverInfo; x: number; y: number }) {
  return (
    <div className="pointer-events-none absolute z-20 max-w-72 rounded-lg border bg-background/95 px-2.5 py-1.5 text-[11px] leading-snug shadow-md backdrop-blur"
      style={{ left: x + 14, top: y + 14 }} role="tooltip">
      <div className="font-medium">{info.title}</div>
      {info.sub && <div className="text-muted-foreground">{info.sub}</div>}
      {info.rows.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {info.rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="truncate text-right tabular-nums">{v}</dd></div>)}
        </dl>
      )}
    </div>
  );
}
