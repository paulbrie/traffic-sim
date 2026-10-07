"use client";

import { Fragment, type ReactNode } from "react";
import { LinkedText } from "./linked-text";

// A small Markdown renderer for the assistant's replies: headings, paragraphs, lists (nested by indent),
// quotes, code blocks, tables, rules; inline code, bold, italic, struck text and links. Plan ids in the text
// (also in inline code) stay clickable, as in LinkedText. Text still being streamed renders as it comes.

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "list"; ordered: boolean; start: number; items: { text: string; sub: string }[] }
  | { t: "table"; head: string[]; align: ("left" | "center" | "right" | null)[]; rows: string[][] }
  | { t: "hr" };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function blocks(src: string): Block[] {
  const lines = src.replace(/\r/g, "").split("\n"), out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ t: "h", level: h[1].length, text: h[2].replace(/\s#+\s*$/, "") }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ t: "hr" }); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = cells(line), align = cells(lines[i + 1]).map(c => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push({ t: "table", head, align, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", text: body.join("\n") });
      continue;
    }
    const li = line.match(LIST);
    if (li) {
      const indent = li[1].length, ordered = /\d/.test(li[2]), items: { text: string; sub: string }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (m && m[1].length <= indent) { items.push({ text: m[3], sub: "" }); i++; continue; }
        // (deeper lines, and wrapped text, belong to the item above; a blank line ends the list unless it goes on)
        if (lines[i].trim() && (m || /^\s+/.test(lines[i]))) { const it = items[items.length - 1]; if (m || /^\s{2,}/.test(lines[i])) it.sub += `${lines[i].slice(Math.min(indent + 2, lines[i].search(/\S/)))}\n`; else it.text += ` ${lines[i].trim()}`; i++; continue; }
        if (!lines[i].trim() && i + 1 < lines.length && (lines[i + 1].match(LIST)?.[1].length ?? -1) >= indent) { i++; continue; }
        break;
      }
      out.push({ t: "list", ordered, start: ordered ? parseInt(li[2], 10) : 1, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>)/.test(lines[i]) && !LIST.test(lines[i])) body.push(lines[i++].trim());
    if (!body.length) body.push(lines[i++].trim());
    out.push({ t: "p", text: body.join("\n") });
  }
  return out;
}

// inline: `code`, **bold**, __bold__, *italic*, _italic_, ~~struck~~, [text](url), bare urls
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;

function inline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, n = 0;
  const plain = (s: string) => s.split("\n").forEach((part, j) => { if (j) out.push(<br key={`${key}b${n++}`} />); if (part) out.push(<LinkedText key={`${key}t${n++}`} text={part} />); });
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) plain(text.slice(last, m.index));
    const k = `${key}${n++}`;
    if (m[1]) out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]"><LinkedText text={m[2]} /></code>);
    else if (m[3] ?? m[4]) out.push(<strong key={k} className="font-semibold">{inline(m[3] ?? m[4], k)}</strong>);
    else if (m[5] ?? m[6]) out.push(<em key={k}>{inline(m[5] ?? m[6], k)}</em>);
    else if (m[7]) out.push(<del key={k}>{inline(m[7], k)}</del>);
    else if (m[8]) out.push(/^https?:\/\//.test(m[9]) ? <a key={k} href={m[9]} target="_blank" rel="noreferrer" className="underline underline-offset-2">{inline(m[8], k)}</a> : <Fragment key={k}>{inline(m[8], k)}</Fragment>);
    else if (m[10]) out.push(<a key={k} href={m[10]} target="_blank" rel="noreferrer" className="underline underline-offset-2 break-all">{m[10]}</a>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) plain(text.slice(last));
  return out;
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 leading-relaxed break-words">
      {blocks(text).map((b, i) => {
        switch (b.t) {
          case "h": return <div key={i} className={b.level <= 2 ? "pt-1 text-[15px] font-semibold" : "pt-1 font-semibold"}>{inline(b.text)}</div>;
          case "p": return <p key={i}>{inline(b.text)}</p>;
          case "hr": return <hr key={i} className="border-border" />;
          case "quote": return <blockquote key={i} className="border-l-2 pl-3 text-muted-foreground"><ChatMarkdown text={b.text} /></blockquote>;
          case "code": return <pre key={i} className="overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-snug"><code>{b.text}</code></pre>;
          case "list": {
            const items = b.items.map((it, j) => <li key={j} className="pl-0.5">{inline(it.text)}{it.sub.trim() && <div className="mt-1"><ChatMarkdown text={it.sub} /></div>}</li>);
            return b.ordered
              ? <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">{items}</ol>
              : <ul key={i} className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{items}</ul>;
          }
          case "table": return (
            <div key={i} className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead><tr>{b.head.map((c, j) => <th key={j} style={{ textAlign: b.align[j] ?? "left" }} className="border-b px-2 py-1 font-semibold">{inline(c)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j} className="border-b last:border-0">{b.head.map((_, k) => <td key={k} style={{ textAlign: b.align[k] ?? "left" }} className="px-2 py-1 align-top">{inline(r[k] ?? "")}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
      })}
    </div>
  );
}
