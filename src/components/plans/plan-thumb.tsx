import type { Network } from "@/engine/types";

/** Small SVG preview of a plan's street network. */
export function PlanThumb({ network, className }: { network: Network; className?: string }) {
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
