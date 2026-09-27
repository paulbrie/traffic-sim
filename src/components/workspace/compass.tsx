"use client";

import { sendView } from "@/state/commands";

/**
 * N/E/S/W compass. The views rotate the dial by writing `--heading` on [data-compass]
 * (the plan view is always north-up; the 3D view follows the camera). Click to face north.
 */
export function Compass() {
  return (
    <button
      type="button" data-compass onClick={() => sendView("north")} aria-label="Compass: click to face north" title="Face north"
      className="absolute right-3 bottom-12 z-10 grid size-16 place-items-center rounded-full border bg-background/90 shadow-sm backdrop-blur transition-colors hover:bg-background"
    >
      <svg viewBox="-32 -32 64 64" className="size-full [transform:rotate(var(--heading,0deg))]" aria-hidden>
        <circle r="30" className="fill-none stroke-border" strokeWidth="1" />
        {Array.from({ length: 16 }, (_, i) => {
          const a = (i * Math.PI) / 8, major = i % 4 === 0, r0 = major ? 21 : 24;
          return <line key={i} x1={Math.sin(a) * r0} y1={-Math.cos(a) * r0} x2={Math.sin(a) * 27} y2={-Math.cos(a) * 27} className="stroke-muted-foreground/50" strokeWidth={major ? 1.2 : 0.8} />;
        })}
        {/* needle: red half points north */}
        <path d="M0 -17 L4.5 0 L-4.5 0 Z" className="fill-red-600 dark:fill-red-500" />
        <path d="M0 17 L4.5 0 L-4.5 0 Z" className="fill-muted-foreground/60" />
        <circle r="1.8" className="fill-background stroke-foreground/60" strokeWidth="0.8" />
        {([["N", 0, -23], ["E", 23, 0], ["S", 0, 23], ["W", -23, 0]] as const).map(([t, x, y]) => (
          <text
            key={t} x={x} y={y} textAnchor="middle" dominantBaseline="central"
            // keep letters upright while the dial turns
            style={{ transform: `rotate(calc(-1 * var(--heading, 0deg)))`, transformBox: "fill-box", transformOrigin: "center" }}
            className={t === "N" ? "fill-red-600 text-[9px] font-bold dark:fill-red-500" : "fill-foreground text-[8px] font-semibold"}
          >{t}</text>
        ))}
      </svg>
    </button>
  );
}
