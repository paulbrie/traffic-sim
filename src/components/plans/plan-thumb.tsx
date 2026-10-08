import type { Network } from "@/engine/types";
import { isFullCircle, outlinePath, samples, type Sketch } from "@/lib/lane-sketch";

/** Small SVG preview of a plan's street network (a V2 plan's: its lane sketch, when given). */
export function PlanThumb({ network, sketch, className }: { network: Network; sketch?: Sketch | null; className?: string }) {
  if (sketch !== undefined) return <SketchThumb sketch={sketch} className={className} />;
  const nodes = new Map(network.nodes.map(n => [n.id, n]));
  if (!network.links.length) {
    return (
      <div className={className}>
        <div className="grid h-full w-full place-items-center rounded-md bg-[var(--map-ground)] text-xs text-muted-foreground">Empty plan</div>
      </div>
    );
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const n of network.nodes) grow(n.x, n.y);
  const w = Math.max(40, maxX - minX), h = Math.max(40, maxY - minY), pad = Math.max(w, h) * 0.08;
  const vb = `${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`;
  const unit = Math.max(w, h) / 160;
  return (
    <div className={className}>
      <svg viewBox={vb} className="h-full w-full rounded-md bg-[var(--map-ground)]" preserveAspectRatio="xMidYMid meet" aria-hidden>
        {network.links.map(l => {
          const a = nodes.get(l.from), b = nodes.get(l.to);
          if (!a || !b) return null;
          const d = l.c1 && l.c2 ? `M${a.x},${a.y} C${l.c1.x},${l.c1.y} ${l.c2.x},${l.c2.y} ${b.x},${b.y}` : `M${a.x},${a.y} L${b.x},${b.y}`;
          return <path key={l.id} d={d} fill="none" stroke="var(--map-asphalt)" strokeLinecap="round" strokeWidth={Math.max(unit * 1.6, (l.lanesF + l.lanesB) * 3.2)} />;
        })}
        {network.nodes.filter(n => n.control === "roundabout").map(n => <circle key={n.id} cx={n.x} cy={n.y} r={10} fill="var(--map-asphalt)" />)}
      </svg>
    </div>
  );
}

/** A V2 plan's preview: its junction surfaces and its lanes, as wide as they are. */
function SketchThumb({ sketch, className }: { sketch: Sketch | null; className?: string }) {
  if (!sketch?.lanes.length) {
    return (
      <div className={className}>
        <div className="grid h-full w-full place-items-center rounded-md bg-[var(--map-ground)] text-xs text-muted-foreground">Empty plan</div>
      </div>
    );
  }
  const lanes = sketch.lanes.map(l => ({ l, pts: samples(l.shape, 2) }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { pts } of lanes) for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const w = Math.max(40, maxX - minX), h = Math.max(40, maxY - minY), pad = Math.max(w, h) * 0.08;
  const d = (pts: { x: number; y: number }[], close = false) => `M${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L")}${close ? " Z" : ""}`;
  return (
    <div className={className}>
      <svg viewBox={`${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`} className="h-full w-full rounded-md bg-[var(--map-ground)]" preserveAspectRatio="xMidYMid meet" aria-hidden>
        {sketch.junctions.filter(j => j.outline.length >= 3 && j.shape !== "auto").map(j => <path key={j.id} d={d(outlinePath(j), true)} fill="var(--map-asphalt)" />)}
        {lanes.map(({ l, pts }) => <path key={l.id} d={d(pts, isFullCircle(l.shape))} fill="none" stroke="var(--map-asphalt)" strokeLinejoin="round" strokeWidth={Math.max(l.width, Math.max(w, h) / 160)} />)}
      </svg>
    </div>
  );
}
