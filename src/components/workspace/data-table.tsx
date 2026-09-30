"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

export type CellValue = string | number | boolean | null;

export interface Column<R> {
  key: string;
  label: string;
  /** px */
  width: number;
  align?: "right";
  /** the value shown and sorted by */
  value: (r: R) => CellValue;
  /** optional nicer rendering */
  render?: (r: R) => React.ReactNode;
  /** editable cell: how to edit and how to save */
  edit?: {
    kind: "text" | "number" | "select" | "check";
    options?: { value: string; label: string }[];
    min?: number; max?: number;
    commit: (r: R, v: string | number | boolean) => void;
  };
}

const ROW = 26;

/**
 * A sortable, filterable, virtualised table (only the visible rows are rendered). Editable cells
 * are edited in place: click (checkboxes and lists) or double-click / Enter (text and numbers).
 */
export function DataTable<R>({ rows, cols, rowKey, selected, onRow, filter }: {
  rows: R[]; cols: Column<R>[]; rowKey: (r: R) => string; selected: string | null; onRow: (r: R) => void; filter: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(240);
  const [editing, setEditing] = useState<{ row: string; col: string; draft: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    let out = f ? rows.filter(r => cols.some(c => String(c.value(r) ?? "").toLowerCase().includes(f))) : rows.slice();
    if (sort) {
      const col = cols.find(c => c.key === sort.key);
      if (col) out = out.sort((a, b) => {
        const x = col.value(a), y = col.value(b);
        if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
        return String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true }) * sort.dir;
      });
    }
    return out;
  }, [rows, cols, filter, sort]);

  const first = Math.max(0, Math.floor(top / ROW) - 5), last = Math.min(shown.length, Math.ceil((top + height) / ROW) + 5);
  const width = cols.reduce((a, c) => a + c.width, 0);

  const save = (r: R, c: Column<R>, raw: string | boolean) => {
    const e = c.edit!;
    if (e.kind === "number") {
      const n = Number(String(raw).replace(",", "."));
      if (!Number.isFinite(n)) return;
      e.commit(r, Math.min(e.max ?? Infinity, Math.max(e.min ?? -Infinity, n)));
    } else e.commit(r, raw);
  };

  return (
    <div
      ref={box} className="min-h-0 flex-1 overflow-auto text-xs"
      onScroll={e => setTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ width, minWidth: "100%" }}>
        <div className="sticky top-0 z-10 flex border-b bg-muted/95 font-medium backdrop-blur" style={{ height: ROW }}>
          {cols.map(c => (
            <button
              key={c.key} type="button" style={{ width: c.width }}
              className={cn("flex shrink-0 items-center gap-1 px-2 text-left hover:bg-accent", c.align === "right" && "justify-end")}
              onClick={() => setSort(s => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}
            >
              {c.label}{sort?.key === c.key && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
            </button>
          ))}
        </div>
        <div style={{ height: shown.length * ROW, position: "relative" }}>
          {shown.slice(first, last).map((r, i) => {
            const k = rowKey(r);
            return (
              <div
                key={k} onClick={() => onRow(r)}
                className={cn("absolute left-0 flex w-full cursor-default border-b border-border/50 hover:bg-accent/60", selected === k && "bg-primary/10")}
                style={{ top: (first + i) * ROW, height: ROW }}
              >
                {cols.map(c => {
                  const isEditing = editing?.row === k && editing.col === c.key;
                  const e = c.edit;
                  let content: React.ReactNode;
                  if (e?.kind === "check") {
                    content = <input type="checkbox" className="size-3.5" checked={!!c.value(r)} onClick={ev => ev.stopPropagation()} onChange={ev => save(r, c, ev.target.checked)} aria-label={c.label} />;
                  } else if (e?.kind === "select") {
                    content = (
                      <select className="h-5 w-full rounded border-none bg-transparent text-xs outline-none hover:bg-background" value={String(c.value(r) ?? "")} onClick={ev => ev.stopPropagation()} onChange={ev => save(r, c, ev.target.value)} aria-label={c.label}>
                        {e.options!.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    );
                  } else if (isEditing) {
                    content = (
                      <input
                        autoFocus className="h-5 w-full rounded border bg-background px-1 text-xs outline-none" value={editing!.draft}
                        onClick={ev => ev.stopPropagation()}
                        onChange={ev => setEditing({ ...editing!, draft: ev.target.value })}
                        onBlur={() => { save(r, c, editing!.draft); setEditing(null); }}
                        onKeyDown={ev => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") setEditing(null); }}
                      />
                    );
                  } else content = c.render ? c.render(r) : String(c.value(r) ?? "–");
                  return (
                    <div
                      key={c.key} style={{ width: c.width }}
                      className={cn("flex shrink-0 items-center truncate px-2", c.align === "right" && "justify-end font-mono tabular", e && !e.kind.match(/check|select/) && "underline decoration-dotted decoration-muted-foreground/60 underline-offset-2")}
                      onDoubleClick={() => e && (e.kind === "text" || e.kind === "number") && setEditing({ row: k, col: c.key, draft: String(c.value(r) ?? "") })}
                      title={e && (e.kind === "text" || e.kind === "number") ? "Double-click to edit" : undefined}
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
