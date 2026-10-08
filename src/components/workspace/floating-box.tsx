"use client";

import { useRef, useState } from "react";

/** where the panel is on the map and its size (px from the map's top left); null: the corner it opens in */
interface Box { x: number; y: number; w: number; h: number }
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const loadBox = (key: string): Box | null => { try { const b = JSON.parse(localStorage.getItem(key) ?? ""); return b && [b.x, b.y, b.w, b.h].every(Number.isFinite) ? b : null; } catch { return null; } };
const EDGES: { e: Edge; cls: string }[] = [
  { e: "n", cls: "top-0 inset-x-2 h-1.5 cursor-ns-resize" }, { e: "s", cls: "bottom-0 inset-x-2 h-1.5 cursor-ns-resize" },
  { e: "w", cls: "left-0 inset-y-2 w-1.5 cursor-ew-resize" }, { e: "e", cls: "right-0 inset-y-2 w-1.5 cursor-ew-resize" },
  { e: "nw", cls: "top-0 left-0 size-3 cursor-nwse-resize" }, { e: "se", cls: "bottom-0 right-0 size-3 cursor-nwse-resize" },
  { e: "ne", cls: "top-0 right-0 size-3 cursor-nesw-resize" }, { e: "sw", cls: "bottom-0 left-0 size-3 cursor-nesw-resize" },
];

/**
 * A floating panel over the map: moved by its title bar and sized by its edges and corners, kept inside the
 * map; remembered in this browser under `storageKey`. `reset` (a double click on the title bar) puts it back
 * where it opens.
 */
export function useFloatingBox(storageKey: string, MIN_W: number, MIN_H: number) {
  const [box, setBox] = useState<Box | null>(() => loadBox(storageKey));
  const panel = useRef<HTMLDivElement>(null);
  const start = (e: React.PointerEvent, edge: Edge | null) => {
    const el = panel.current, parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || e.button !== 0) return;
    e.preventDefault();
    const pr = parent.getBoundingClientRect(), r = el.getBoundingClientRect();
    const b0 = { x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height }, x0 = e.clientX, y0 = e.clientY;
    let last = b0;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0, pw = parent.clientWidth, ph = parent.clientHeight;
      let { x, y, w, h } = b0;
      if (!edge) { x = Math.max(0, Math.min(pw - w, x + dx)); y = Math.max(0, Math.min(ph - h, y + dy)); }
      else {
        if (edge.includes("e")) w = Math.max(MIN_W, Math.min(pw - x, w + dx));
        if (edge.includes("s")) h = Math.max(MIN_H, Math.min(ph - y, h + dy));
        if (edge.includes("w")) { const nx = Math.max(0, Math.min(x + w - MIN_W, x + dx)); w += x - nx; x = nx; }
        if (edge.includes("n")) { const ny = Math.max(0, Math.min(y + h - MIN_H, y + dy)); h += y - ny; y = ny; }
      }
      last = { x, y, w, h };
      setBox(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      try { localStorage.setItem(storageKey, JSON.stringify(last)); } catch { /* private mode */ }
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => { setBox(null); try { localStorage.removeItem(storageKey); } catch { /* private mode */ } };
  // (kept inside the map when it gets smaller than when the panel was placed)
  const style: React.CSSProperties | undefined = box ? {
    left: `max(0px, min(${box.x}px, calc(100% - ${box.w}px)))`, top: `max(0px, min(${box.y}px, calc(100% - ${box.h}px)))`,
    width: `min(${box.w}px, 100%)`, height: `min(${box.h}px, 100%)`,
  } : undefined;
  return { panel, style, placed: !!box, start, reset };
}

/** the panel's invisible edges and corners to size it by */
export function ResizeEdges({ start }: { start: (e: React.PointerEvent, edge: Edge) => void }) {
  return <>{EDGES.map(({ e, cls }) => <div key={e} aria-hidden className={`absolute z-10 touch-none ${cls}`} onPointerDown={ev => start(ev, e)} />)}</>;
}
