"use client";

/**
 * A demand matrix edited as a spreadsheet (ticket #113): a row for each way in, a column for each way out, vehicles per hour
 * in each cell, the rows' and columns' totals. Click a cell and type (Enter, Tab and the arrows move on; Delete clears;
 * Shift with a click or the arrows takes in a block); ⌘C / Ctrl+C copies the block, ⌘V / Ctrl+V pastes one (from a
 * spreadsheet: tab-separated) from the cell picked. Pairs with no way between them are greyed (nothing can be put there).
 * Only the rows and columns in view are drawn, so a big sketch's hundreds of ways stay quick. Its name, period of the day,
 * trucks and a scaling of every cell above. Each change one undo step.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";
import { hhmm, matrixGrid, matrixText, parseCells, parseHhmm, reachable, scaleMatrix, setCells, updateMatrix } from "@/lib/demand-matrix";
import type { DemandWay, Sketch } from "@/lib/lane-sketch";
import { useSketchStore } from "@/state/lane-sketch";

const ROW_H = 26, COL_W = 78, HEAD_W = 190, HEAD_H = 64, OVER = 4;
interface At { r: number; c: number }
const fmt = (v: number) => (v ? String(Math.round(v * 10) / 10) : "");

export function MatrixDialog({ sketch, id, entries, exits, readOnly, onClose }: {
  sketch: Sketch; id: string; entries: DemandWay[]; exits: DemandWay[]; readOnly: boolean; onClose: () => void;
}) {
  const { edit: editSketch } = useSketchStore();
  const m = sketch.matrices?.find(x => x.id === id);
  const g = useMemo(() => (m ? matrixGrid(sketch, m) : null), [sketch, m]);
  const can = useMemo(() => reachable(sketch), [sketch]);
  const R = entries.length, C = exits.length;
  const [sel, setSel] = useState<At>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<At>({ r: 0, c: 0 });
  const [editing, setEditingState] = useState<string | null>(null);
  // (what is typed, kept beside the state too: Enter commits it and takes the field away, whose blur then mustn't commit it twice)
  const typed = useRef<string | null>(null);
  const setEditing = (v: string | null) => { typed.current = v; setEditingState(v); };
  const [scroll, setScroll] = useState({ x: 0, y: 0, w: 900, h: 500 });
  const [scale, setScale] = useState(100);
  const box = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null), dragging = useRef(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll(s => ({ ...s, w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [m?.id]);
  // (the cell picked kept in view)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const x = HEAD_W + sel.c * COL_W, y = HEAD_H + sel.r * ROW_H;
    if (x < el.scrollLeft + HEAD_W) el.scrollLeft = x - HEAD_W; else if (x + COL_W > el.scrollLeft + el.clientWidth) el.scrollLeft = x + COL_W - el.clientWidth;
    if (y < el.scrollTop + HEAD_H) el.scrollTop = y - HEAD_H; else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H - el.clientHeight;
  }, [sel]);
  if (!m || !g) return null;

  const value = (r: number, c: number) => g.cell.get(entries[r].key)?.get(exits[c].key) ?? 0;
  const open = (r: number, c: number) => !!can.get(entries[r].key)?.has(exits[c].key);
  const range = { r0: Math.min(sel.r, anchor.r), r1: Math.max(sel.r, anchor.r), c0: Math.min(sel.c, anchor.c), c1: Math.max(sel.c, anchor.c) };
  const inRange = (r: number, c: number) => r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;
  /** cells set, one undo step; those with no way between them left out (how many, said) */
  const put = (cells: { r: number; c: number; rate: number }[]) => {
    if (readOnly) return;
    const ok = cells.filter(x => x.r < R && x.c < C && (open(x.r, x.c) || x.rate === 0)), shut = cells.length - ok.length;
    if (ok.length) editSketch(s => setCells(s, id, ok.map(x => ({ from: entries[x.r], to: exits[x.c], rate: x.rate }))));
    if (shut) toast(`${shut} cell${shut === 1 ? "" : "s"} left empty`, { description: "No way leads from that way in to that way out." });
  };
  const move = (dr: number, dc: number, extend = false) => {
    const n = { r: Math.max(0, Math.min(R - 1, sel.r + dr)), c: Math.max(0, Math.min(C - 1, sel.c + dc)) };
    setSel(n);
    if (!extend) setAnchor(n);
  };
  const commit = (then?: () => void) => {
    const t = typed.current;
    if (t !== null) {
      setEditing(null);
      const v = Number(t.trim().replace(",", "."));
      if (t.trim() === "" || (Number.isFinite(v) && v >= 0)) put([{ r: sel.r, c: sel.c, rate: t.trim() === "" ? 0 : v }]);
      else toast.error(`"${t}" isn't a number of vehicles an hour`);
    }
    then?.();
    grid.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    // (the editor under the dialog doesn't see its keys)
    e.stopPropagation();
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    if (editing !== null) {
      if (k === "Enter") { e.preventDefault(); commit(() => move(e.shiftKey ? -1 : 1, 0)); }
      else if (k === "Tab") { e.preventDefault(); commit(() => move(0, e.shiftKey ? -1 : 1)); }
      else if (k === "Escape") { e.preventDefault(); setEditing(null); grid.current?.focus(); }
      else if (k === "ArrowUp" || k === "ArrowDown") { e.preventDefault(); commit(() => move(k === "ArrowUp" ? -1 : 1, 0)); }
      return;
    }
    if (mod && k.toLowerCase() === "a") { e.preventDefault(); setAnchor({ r: 0, c: 0 }); setSel({ r: R - 1, c: C - 1 }); return; }
    if (mod && k.toLowerCase() === "c") {
      e.preventDefault();
      const rows = [];
      for (let r = range.r0; r <= range.r1; r++) { const row = []; for (let c = range.c0; c <= range.c1; c++) row.push(String(value(r, c))); rows.push(row.join("\t")); }
      void navigator.clipboard.writeText(rows.join("\n")).then(() => toast(`Copied ${(range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1)} cells`));
      return;
    }
    if (mod) return;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { e.preventDefault(); move(arrows[k][0], arrows[k][1], e.shiftKey); return; }
    if (k === "Tab") { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return; }
    if (k === "Enter" || k === "F2") { e.preventDefault(); if (!readOnly && open(sel.r, sel.c)) setEditing(fmt(value(sel.r, sel.c))); return; }
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      const cells = [];
      for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) if (value(r, c)) cells.push({ r, c, rate: 0 });
      put(cells);
      return;
    }
    if (/^[0-9.,]$/.test(k) && !readOnly && open(sel.r, sel.c)) { e.preventDefault(); setEditing(k === "," ? "." : k); }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing !== null || readOnly) return;
    e.preventDefault();
    const rows = parseCells(e.clipboardData.getData("text/plain")), cells: { r: number; c: number; rate: number }[] = [];
    let bad = 0;
    rows.forEach((row, i) => row.forEach((v, j) => { if (v === null) bad++; else cells.push({ r: sel.r + i, c: sel.c + j, rate: v }); }));
    const out = cells.filter(x => x.r >= R || x.c >= C).length;
    put(cells.filter(x => x.r < R && x.c < C));
    setAnchor(sel); setSel({ r: Math.min(R - 1, sel.r + rows.length - 1), c: Math.min(C - 1, sel.c + Math.max(...rows.map(r => r.length)) - 1) });
    if (bad || out) toast(`Pasted ${cells.length - out} cells`, { description: [bad && `${bad} weren't numbers (a header row or column? Paste the numbers only)`, out && `${out} fell outside the matrix`].filter(Boolean).join("; ") });
  };
  const at = (e: React.MouseEvent): At | null => {
    const rect = box.current!.getBoundingClientRect(), x = e.clientX - rect.left + box.current!.scrollLeft - HEAD_W, y = e.clientY - rect.top + box.current!.scrollTop - HEAD_H;
    if (x < 0 || y < 0 || e.clientX - rect.left < HEAD_W || e.clientY - rect.top < HEAD_H) return null;
    const c = Math.floor(x / COL_W), r = Math.floor(y / ROW_H);
    return r < R && c < C ? { r, c } : null;
  };

  // the rows and columns in view
  const r0 = Math.max(0, Math.floor((scroll.y) / ROW_H) - OVER), r1 = Math.min(R, Math.ceil((scroll.y + scroll.h) / ROW_H) + OVER);
  const c0 = Math.max(0, Math.floor((scroll.x) / COL_W) - OVER), c1 = Math.min(C, Math.ceil((scroll.x + scroll.w) / COL_W) + OVER);
  const rows = Array.from({ length: Math.max(0, r1 - r0) }, (_, i) => r0 + i), cols = Array.from({ length: Math.max(0, c1 - c0) }, (_, i) => c0 + i);
  const W = HEAD_W + (C + 1) * COL_W, H = HEAD_H + (R + 1) * ROW_H;
  const allDay = m.start === undefined || m.end === undefined;
  const setPeriod = (start: number | undefined, end: number | undefined) => editSketch(s => updateMatrix(s, id, { start, end }));
  const num = "font-mono text-[11px] tabular";

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="flex h-[88vh] max-w-[min(1400px,96vw)] flex-col gap-3 sm:max-w-[min(1400px,96vw)]" onKeyDown={e => e.stopPropagation()}
        onEscapeKeyDown={e => { if (editing !== null) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Demand matrix</DialogTitle>
          <DialogDescription>Vehicles per hour from each way in (rows) to each way out (columns). Click a cell and type, or paste a block from a spreadsheet (numbers only, from the cell picked); Shift takes in a block, ⌘C / Ctrl+C copies it. Grey: no way leads there.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="grid gap-1">
            <span className="text-muted-foreground">Name</span>
            <Input key={`n-${m.id}`} defaultValue={m.name} disabled={readOnly} className="h-8 w-48 text-xs" maxLength={60}
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== m.name) editSketch(s => updateMatrix(s, id, { name: v })); }}
              onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          </label>
          <div className="grid gap-1">
            <span className="text-muted-foreground" title="Used by the time of day in this period; it may run past midnight (22:00 to 06:00)">Period of the day</span>
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-1"><input type="checkbox" className="accent-primary" checked={allDay} disabled={readOnly} onChange={e => setPeriod(e.target.checked ? undefined : 7 * 60, e.target.checked ? undefined : 9 * 60)} /> All day</label>
              {!allDay && <>
                <TimeField label="Period starts" value={m.start!} disabled={readOnly} onCommit={v => setPeriod(v, m.end)} />
                <span>to</span>
                <TimeField label="Period ends" value={m.end!} disabled={readOnly} onCommit={v => setPeriod(m.start, v)} />
              </>}
            </div>
          </div>
          <NumberField id={`mx-trucks-${m.id}`} label="Trucks" unit="%" digits={0} min={0} max={100} step={5} className="w-24" value={m.trucks ?? 0}
            onCommit={v => editSketch(s => updateMatrix(s, id, { trucks: Math.round(v) }))} />
          <div className="flex items-end gap-1">
            <NumberField id={`mx-scale-${m.id}`} label="Scale every cell" unit="%" digits={0} min={1} max={1000} step={5} className="w-28" value={scale} onCommit={setScale} />
            <Button size="sm" variant="outline" className="h-8" disabled={readOnly || scale === 100 || !g.total} onClick={() => { editSketch(s => scaleMatrix(s, id, scale / 100)); setScale(100); }}>Apply</Button>
          </div>
          <div className="ml-auto flex items-end gap-2">
            <span className="pb-2 text-muted-foreground">{R} ways in × {C} ways out · <span className={num}>{Math.round(g.total)}</span> veh/h in all</span>
            <Button size="sm" variant="outline" className="h-8" title="Copy the whole matrix with the ways' names, to paste into a spreadsheet"
              onClick={() => void navigator.clipboard.writeText(matrixText(sketch, m, { entries, exits })).then(() => toast("Matrix copied, with the ways' names"))}><Copy /> Copy all</Button>
          </div>
        </div>
        {g.orphans > 0 && <p className="text-[11px] text-amber-700 dark:text-amber-500">{g.orphans} cell{g.orphans === 1 ? " is" : "s are"} for ways that are gone (lanes deleted): left out.</p>}
        {!R || !C ? <p className="text-sm text-muted-foreground">This sketch has no ways in or no ways out yet.</p> : (
          <div ref={box} className="relative min-h-0 flex-1 overflow-auto rounded-md border text-xs select-none"
            onScroll={e => { const el = e.currentTarget; setScroll(s => ({ ...s, x: el.scrollLeft, y: el.scrollTop })); }}>
            <div ref={grid} tabIndex={0} role="grid" aria-label={`${m.name}: vehicles per hour from each way in to each way out`} aria-rowcount={R} aria-colcount={C}
              className="relative outline-none" style={{ width: W, height: H }} onKeyDown={onKey} onPaste={onPaste}
              onMouseDown={e => { const p = at(e); if (!p) return; if (editing !== null) commit(); setSel(p); if (!e.shiftKey) setAnchor(p); dragging.current = true; grid.current?.focus(); e.preventDefault(); }}
              onMouseMove={e => { if (!dragging.current) return; const p = at(e); if (p) setSel(p); }}
              onMouseUp={() => { dragging.current = false; }} onMouseLeave={() => { dragging.current = false; }}
              onDoubleClick={e => { const p = at(e); if (p && !readOnly && open(p.r, p.c)) { setSel(p); setAnchor(p); setEditing(fmt(value(p.r, p.c))); } }}>
              {rows.map(r => cols.map(c => {
                const v = value(r, c), ok = open(r, c), picked = r === sel.r && c === sel.c;
                return (
                  <div key={`${r}:${c}`} role="gridcell" aria-selected={inRange(r, c)}
                    className={cn("absolute flex items-center justify-end border-r border-b px-1.5", num, !ok && "bg-muted/60 text-muted-foreground", inRange(r, c) && "bg-primary/10", picked && "outline-2 -outline-offset-2 outline-primary", !ok && v > 0 && "text-amber-700")}
                    style={{ left: HEAD_W + c * COL_W, top: HEAD_H + r * ROW_H, width: COL_W, height: ROW_H }}
                    title={`${entries[r].name} → ${exits[c].name}${ok ? "" : " (no way there)"}`}>
                    {picked && editing !== null ? (
                      <input autoFocus value={editing} aria-label={`${entries[r].name} to ${exits[c].name}, vehicles per hour`} inputMode="decimal"
                        className="absolute inset-0 w-full bg-background px-1.5 text-right outline-2 -outline-offset-2 outline-primary"
                        onChange={e => setEditing(e.target.value)} onBlur={() => commit()} onMouseDown={e => e.stopPropagation()} />
                    ) : ok ? fmt(v) : v > 0 ? fmt(v) : "—"}
                  </div>
                );
              }))}
              {/* the rows' totals, the columns' totals */}
              {rows.map(r => (
                <div key={`t:${r}`} className={cn("absolute flex items-center justify-end border-b border-l-2 bg-muted/40 px-1.5 font-medium", num)} style={{ left: HEAD_W + C * COL_W, top: HEAD_H + r * ROW_H, width: COL_W, height: ROW_H }}>{fmt(g.rows.get(entries[r].key) ?? 0) || "0"}</div>
              ))}
              {cols.map(c => (
                <div key={`T:${c}`} className={cn("absolute flex items-center justify-end border-t-2 border-r bg-muted/40 px-1.5 font-medium", num)} style={{ left: HEAD_W + c * COL_W, top: HEAD_H + R * ROW_H, width: COL_W, height: ROW_H }}>{fmt(g.cols.get(exits[c].key) ?? 0) || "0"}</div>
              ))}
              <div className={cn("absolute flex items-center justify-end border-t-2 border-l-2 bg-muted px-1.5 font-semibold", num)} style={{ left: HEAD_W + C * COL_W, top: HEAD_H + R * ROW_H, width: COL_W, height: ROW_H }}>{Math.round(g.total)}</div>
              {/* the headers, kept in view: the ways out along the top, the ways in down the side */}
              {cols.map(c => (
                <div key={`h:${c}`} className={cn("absolute z-10 flex items-end border-r border-b bg-background px-1.5 pb-1 text-[11px] leading-tight font-medium", c === sel.c && "bg-primary/10")}
                  style={{ left: HEAD_W + c * COL_W, top: scroll.y, width: COL_W, height: HEAD_H }} title={`${exits[c].name}: ${exits[c].lanes.join(", ")}`}>
                  <span className="line-clamp-3 break-words">{exits[c].name}</span>
                </div>
              ))}
              <div className="absolute z-10 flex items-end border-b border-l-2 bg-muted px-1.5 pb-1 text-[11px] font-semibold" style={{ left: HEAD_W + C * COL_W, top: scroll.y, width: COL_W, height: HEAD_H }}>Total</div>
              {rows.map(r => (
                <div key={`v:${r}`} className={cn("absolute z-10 flex items-center border-r border-b bg-background px-2 text-[11px] font-medium", r === sel.r && "bg-primary/10")}
                  style={{ left: scroll.x, top: HEAD_H + r * ROW_H, width: HEAD_W, height: ROW_H }} title={`${entries[r].name}: ${entries[r].lanes.join(", ")}`}>
                  <span className="truncate">{entries[r].name}</span>
                </div>
              ))}
              <div className="absolute z-10 flex items-center border-t-2 border-r bg-muted px-2 text-[11px] font-semibold" style={{ left: scroll.x, top: HEAD_H + R * ROW_H, width: HEAD_W, height: ROW_H }}>Total</div>
              <div className="absolute z-20 flex items-end border-r border-b bg-background px-2 pb-1 text-[11px] text-muted-foreground" style={{ left: scroll.x, top: scroll.y, width: HEAD_W, height: HEAD_H }}>from ↓ · to →</div>
            </div>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          {entries[sel.r] && exits[sel.c] ? <>{entries[sel.r].name} → {exits[sel.c].name}: <span className={num}>{fmt(value(sel.r, sel.c)) || "0"}</span> veh/h{open(sel.r, sel.c) ? "" : " · no way leads there"}</> : null}
          {range.r1 > range.r0 || range.c1 > range.c0 ? ` · block ${range.r1 - range.r0 + 1} × ${range.c1 - range.c0 + 1}` : ""}
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** a time of day, "07:30" (minutes after midnight), committed on Enter or leaving it */
export function TimeField({ label, value, onCommit, disabled, className }: { label: string; value: number; onCommit: (min: number) => void; disabled?: boolean; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    if (draft === null) return;
    const v = parseHhmm(draft);
    if (v === null) toast.error(`"${draft}" isn't a time of day`, { description: "As 07:30" });
    else if (v !== value) onCommit(v);
    setDraft(null);
  };
  return (
    <Input aria-label={label} value={draft ?? hhmm(value)} disabled={disabled} className={cn("h-8 w-16 text-center font-mono text-xs tabular", className)} placeholder="07:30"
      onChange={e => setDraft(e.target.value)} onBlur={done} onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(null); }} />
  );
}
