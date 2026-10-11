/**
 * An agent's report to the page (T196, `bridge_report`): a title, a few lines, a table of results (rows to point out, a note
 * under it) and findings, shown in a window over the page and kept in the Claude panel. Plain data, checked here: no markup,
 * nothing run; the sizes bounded so a report stays readable.
 */
export interface BridgeReportTable { columns: string[]; rows: (string | number | null)[][]; highlight?: number[]; note?: string }
export interface BridgeReport { id: string; at: number; by: string; title: string; intro?: string; table?: BridgeReportTable; findings?: string[] }

const MAX_COLS = 14, MAX_ROWS = 60, MAX_CELL = 80, MAX_LINE = 600, MAX_FINDINGS = 24;
const text = (v: unknown, what: string, max: number, need = false): string | undefined => {
  if (v === undefined || v === null || v === "") { if (need) throw new Error(`"${what}" is needed`); return undefined; }
  if (typeof v !== "string") throw new Error(`"${what}": text`);
  const t = v.trim();
  if (t.length > max) throw new Error(`"${what}": at most ${max} characters`);
  return t || undefined;
};

/** a report from the agent's arguments, or why not */
export function parseReport(a: Record<string, unknown>, by: string, id: string, at: number): BridgeReport {
  const known = new Set(["title", "intro", "table", "findings"]);
  for (const k of Object.keys(a)) if (!known.has(k)) throw new Error(`"${k}" isn't part of a report (title, intro, table, findings)`);
  const r: BridgeReport = { id, at, by, title: text(a.title, "title", 120, true)! };
  const intro = text(a.intro, "intro", MAX_LINE * 2);
  if (intro) r.intro = intro;
  if (a.table !== undefined) {
    const t = a.table as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`"table": { columns, rows, highlight?, note? }`);
    if (!Array.isArray(t.columns) || !t.columns.length || t.columns.length > MAX_COLS) throw new Error(`"table.columns": 1 to ${MAX_COLS} names`);
    const columns = t.columns.map((c, i) => text(c, `table.columns[${i}]`, MAX_CELL, true)!);
    if (!Array.isArray(t.rows) || t.rows.length > MAX_ROWS) throw new Error(`"table.rows": at most ${MAX_ROWS} rows`);
    const rows = t.rows.map((row, i) => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new Error(`"table.rows[${i}]": ${columns.length} cells, as the columns`);
      return row.map((c, j) => {
        if (c === null || (typeof c === "number" && Number.isFinite(c))) return c;
        return text(c, `table.rows[${i}][${j}]`, MAX_CELL) ?? null;
      });
    });
    const table: BridgeReportTable = { columns, rows };
    if (t.highlight !== undefined) {
      if (!Array.isArray(t.highlight) || t.highlight.some(h => !Number.isInteger(h) || (h as number) < 0 || (h as number) >= rows.length)) throw new Error(`"table.highlight": row numbers from 0`);
      table.highlight = t.highlight as number[];
    }
    const note = text(t.note, "table.note", MAX_LINE);
    if (note) table.note = note;
    r.table = table;
  }
  if (a.findings !== undefined) {
    if (!Array.isArray(a.findings) || a.findings.length > MAX_FINDINGS) throw new Error(`"findings": at most ${MAX_FINDINGS} lines`);
    const f = a.findings.map((x, i) => text(x, `findings[${i}]`, MAX_LINE, true)!);
    if (f.length) r.findings = f;
  }
  if (!r.intro && !r.table && !r.findings) throw new Error("a report needs an intro, a table or findings");
  return r;
}

/** the report as plain text (the table tab-separated), to copy */
export function reportText(r: BridgeReport): string {
  const out = [r.title, ""];
  if (r.intro) out.push(r.intro, "");
  if (r.table) {
    out.push(r.table.columns.join("\t"), ...r.table.rows.map(row => row.map(c => (c === null ? "" : String(c))).join("\t")));
    if (r.table.note) out.push("", r.table.note);
    out.push("");
  }
  if (r.findings) out.push(...r.findings.map(f => `- ${f}`));
  return out.join("\n").trimEnd() + "\n";
}
