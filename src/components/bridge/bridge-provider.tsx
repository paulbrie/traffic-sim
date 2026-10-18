"use client";

/**
 * The Claude bridge in the page (docs/claude-bridge.md), on every page, idle until an admin pairs it (Connect Claude, in
 * the account menu): its panel (the code to give the agent, who is attached, disconnect, every command it ran, a message
 * box, the pen), a badge while an agent is attached, the agent's cursor moving to what it acts on and a line saying what
 * it did, and annotations: a rectangle drawn (or a spot clicked) with a note, sent to the agent with what is under it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bot, ClipboardCopy, FileText, Hand, PenLine, Play, Send, Unplug, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reportText, type BridgeReport } from "@/lib/bridge-report";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { bridgeCanvas, bridgeEditScope, bridgeState, bridgeToWorld } from "@/state/bridge-registry";
import { type BridgeView, bridgeAddAgent, bridgeAllowEdits, bridgeAllowTabs, bridgeCloseTab, bridgeDenyRequest, bridgeDisconnect, bridgeFocusTab, bridgeHello, bridgeOpenRequest, bridgePair, bridgePauseTab, bridgeResume, bridgeRevoke, bridgeSend, bridgeStore, bridgeTakeOver, setBridgeNavigate } from "@/state/bridge-client";
import { under } from "./a11y";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** a time left as m:ss */
const left = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
/** how long ago, in a few words */
const ago = (ms: number) => (ms < 10_000 ? "just now" : ms < 60_000 ? `${Math.floor(ms / 1000)} s ago` : ms < 3600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3600_000)} h ago`);
/** an agent quiet this long is said to be (it acts only while its session is working) */
const QUIET = 120_000;
/** a message still "sent" this long gets a word on why */
const SENT_HINT = 20_000;
/** the time now, again every `every` ms while `on` (for countdowns and "seen … ago") */
function useNow(every: number, on = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const tick = () => setNow(Date.now()), first = setTimeout(tick, 0), t = setInterval(tick, every);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [every, on]);
  return now;
}

export function BridgeProvider() {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  const router = useRouter(), pathname = usePathname();
  const [annotating, setAnnotating] = useState(false);
  const paired = view.phase === "waiting" || view.phase === "attached";

  useEffect(() => { setBridgeNavigate(path => router.push(path)); void bridgeResume(); }, [router]);
  useEffect(() => { bridgeHello(); }, [pathname]);
  // (A, while paired and not typing: a note for the agent)
  useEffect(() => {
    if (!paired) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key.toLowerCase() !== "a" || e.ctrlKey || e.metaKey || e.altKey || (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName)))) return;
      e.preventDefault(); e.stopPropagation(); setAnnotating(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paired]);

  const isTab = view.mode === "tab" && !!view.tab;
  if (!view.open && !paired && view.phase !== "lost" && !isTab) return null;
  return (
    <div data-bridge-ui>
      {isTab && <AgentTabChrome />}
      {view.open ? <BridgePanel onAnnotate={() => setAnnotating(true)} /> : isTab ? null : paired || view.phase === "lost" ? (
        // (while paired, always in sight: who is attached, one click to the panel)
        <button className={cn("fixed right-3 bottom-3 z-[60] flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs shadow-md",
          view.phase === "attached" ? "border-violet-400 bg-violet-50 text-violet-900 dark:bg-violet-950 dark:text-violet-100" : "bg-background text-muted-foreground")}
          onClick={() => bridgeStore.show(true)}>
          <Bot className="size-3.5" />
          {view.phase === "attached" ? `${view.agent} is working here` : view.phase === "lost" ? "Claude pairing lost · pair again" : `Waiting for Claude · ${view.code}`}
          {view.reconnecting && " · reconnecting…"}
          {view.tabs.filter(t => !t.left).length > 0 && ` · ${view.tabs.filter(t => !t.left).length} agent tab${view.tabs.filter(t => !t.left).length === 1 ? "" : "s"}`}
          {view.requests.length > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-white">{view.requests.length} to open</span>}
        </button>
      ) : null}
      {view.phase === "attached" && view.cursor && <AgentCursor x={view.cursor.x} y={view.cursor.y} name={view.agent ?? "Claude"} color={view.agentColor ?? "#7c3aed"} note={view.note} />}
      {view.phase === "attached" && view.trace && <Trace text={view.trace.text} at={view.trace.at} />}
      {annotating && <Annotator onDone={() => setAnnotating(false)} />}
      <ReportWindow report={view.reports.find(r => r.id === view.reportOpen) ?? null} />
    </div>
  );
}

function BridgePanel({ onAnnotate }: { onAnnotate: () => void }) {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  const [text, setText] = useState("");
  const paired = view.phase === "waiting" || view.phase === "attached";
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      const to = await bridgeSend({ kind: "message", text: t });
      setText("");
      if (to > 0) toast.success("Sent: it shows as delivered once the agent has it");
      else toast.warning("No agent is connected to take it");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Not sent"); }
  };
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [view.log.length]);
  // (a message still "sent" a while: said why, under the log (T193))
  const anySent = view.log.some(e => e.status === "sent"), now = useNow(5000, anySent);
  const waiting = anySent ? view.log.filter(e => e.status === "sent" && now - e.at > SENT_HINT).pop() : undefined;
  return (
    <div className="fixed right-3 bottom-3 z-[60] flex max-h-[70vh] w-96 flex-col rounded-lg border bg-background shadow-xl" role="dialog" aria-label="Claude bridge">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Bot className="size-4 text-violet-600" />
        <span className="text-sm font-medium">Claude bridge</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {view.reconnecting ? "reconnecting…" : view.phase === "attached" ? `${view.agent} attached` : view.phase === "waiting" ? "waiting for the agent" : view.phase === "pairing" ? "pairing…" : view.phase === "lost" ? "pairing lost" : "not connected"}
        </span>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Close the panel" onClick={() => bridgeStore.show(false)}><X /></Button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 p-3">
        {!paired ? (
          <>
            {view.mode === "tab" && view.error && <p className="text-xs text-red-600">This tab was opened for an agent, but couldn&apos;t pair: {view.error}</p>}
            {view.phase === "lost" && (
              <p className="rounded-md border border-amber-400 bg-amber-50 p-2 text-xs dark:bg-amber-950" role="alert">
                <b>Pairing lost.</b> {view.lostWhy ?? "The connection to the server ended."}
              </p>
            )}
            <p className="text-xs text-muted-foreground">An agent (a Claude session with the bridge) can read this page, act in it — you see its cursor and every command — and get your notes. Pair, then give it the code.</p>
            {view.error && <p className="text-xs text-red-600">{view.error}</p>}
            <Button size="sm" onClick={() => void bridgePair()} disabled={view.phase === "pairing"}>{view.phase === "lost" ? "Pair again" : "Pair this page"}</Button>
          </>
        ) : (
          <>
            {view.phase === "waiting" && view.mode === "hub" && <HubCode />}
            {view.phase === "attached" && view.mode === "hub" && <CodeUsed />}
            {view.reconnecting && <p className="text-[11px] text-muted-foreground">The connection dropped: reconnecting. The pairing stands unless the server no longer knows it.</p>}
            <div className="flex min-w-0 gap-1.5">
              <Button size="sm" variant="outline" className="min-w-0 flex-1" onClick={onAnnotate} title="Draw a rectangle (or click a spot) and write a note for the agent (A)"><PenLine /> Annotate</Button>
              <Button size="sm" variant="outline" onClick={() => void bridgeDisconnect()} title="End the pairing: the agent can't act here any more"><Unplug /> Disconnect</Button>
            </div>
            <div className="flex gap-1.5">
              <Input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void send(); }} placeholder="A message to the agent" aria-label="Message to the agent" className="h-8 text-xs" />
              <Button size="icon-sm" className="size-8" aria-label="Send the message" disabled={!text.trim()} onClick={() => void send()}><Send /></Button>
            </div>
            {view.reports.length > 0 && (
              <div className="grid gap-1" aria-label="Reports from the agents">
                {view.reports.slice().reverse().map(r => (
                  <button key={r.id} className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs hover:bg-muted" onClick={() => bridgeStore.openReport(r.id)} title="Show the report">
                    <FileText className="size-3.5 shrink-0 text-violet-600" />
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    <span className="shrink-0 text-muted-foreground">{r.by} · {clock(r.at)}</span>
                  </button>
                ))}
              </div>
            )}
            {view.mode === "hub" && <AgentTabsSection />}
          </>
        )}
      </div>
      {view.log.length > 0 && (
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto border-t font-mono text-[11px]" aria-label="What the agent did">
          {view.log.map((e, i) => (
            <div key={i} className="flex gap-2 border-b border-border/50 px-3 py-1" title={e.error}>
              <span className="text-muted-foreground tabular-nums">{clock(e.at)}</span>
              <span className={cn("w-16 shrink-0", e.ok ? "text-foreground" : "text-red-600")}>{e.type}</span>
              <span className="min-w-0 flex-1 truncate">{e.target}{e.error ? ` — ${e.error}` : ""}</span>
              {e.status && <span className={cn("shrink-0", e.status === "delivered" ? "text-emerald-600" : e.status === "nobody" ? "text-red-600" : "text-muted-foreground")} title={e.status === "sent" ? sentWhy(view, e.at) : undefined}>{e.status === "delivered" ? `delivered to ${e.by}` : e.status === "nobody" ? "no agent" : now - e.at > SENT_HINT ? "sent · waiting" : "sent"}</span>}
            </div>
          ))}
        </div>
      )}
      {waiting && <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground" role="status">{sentWhy(view, waiting.at, now)}</p>}
    </div>
  );
}

/** the hub's own code while no agent has used it: how long it holds, then that it has expired, and a new one (T193) */
function HubCode() {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  const now = useNow(1000), rest = view.codeExpires === null ? null : view.codeExpires - now;
  if (rest !== null && rest <= 0) return (
    <div className="grid gap-1.5 rounded-md border border-amber-400 bg-amber-50 p-2 text-xs dark:bg-amber-950" role="alert">
      <span>The code <span className="font-mono line-through">{view.code}</span> has expired (a code holds 10 minutes) and no agent used it.</span>
      <Button size="sm" className="h-7 text-xs" onClick={() => void bridgeDisconnect().then(() => bridgePair())}>New code</Button>
    </div>
  );
  return (
    <div className="grid gap-1 rounded-md bg-muted p-2 text-center">
      <span className="text-[11px] text-muted-foreground">Give the agent this code{rest !== null ? <> · valid <span className="tabular-nums">{left(rest)}</span> more</> : " (valid 10 minutes)"}</span>
      <span className="font-mono text-2xl tracking-[0.3em] tabular-nums">{view.code}</span>
    </div>
  );
}
/** (the hub, an agent attached) who used its code, and when */
function CodeUsed() {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  const use = view.codesUsed.find(u => u.code === view.code) ?? view.codesUsed.filter(u => u.by === view.agent).pop();
  return use ? <p className="text-[11px] text-muted-foreground">Code {use.code} used by {use.by} at {hm(use.at)}: it can&apos;t be used again.</p> : null;
}
/** a code for another agent: how long it holds, that it has expired, or who used it (T193) */
function AgentCode({ code }: { code: { code: string; expiresAt: number } }) {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  const use = view.codesUsed.find(u => u.code === code.code), now = useNow(1000, !use), rest = code.expiresAt - now;
  if (use) return <span className="text-[11px] text-muted-foreground">{code.code} used by {use.by} at {hm(use.at)}</span>;
  if (rest <= 0) return <span className="text-[11px] text-amber-700 dark:text-amber-400"><span className="font-mono line-through">{code.code}</span> expired: Add agent for a new one</span>;
  return (
    <span className="flex items-baseline gap-1.5" title="Give this code to the other agent (valid 10 minutes, once)">
      <span className="font-mono text-sm tracking-[0.2em] tabular-nums">{code.code}</span>
      <span className="text-[11px] text-muted-foreground tabular-nums">valid {left(rest)}</span>
    </span>
  );
}
/** when an agent last called the bridge; quiet a while, a word on what that means (T193) */
function Seen({ agent }: { agent: { name: string; lastSeen: number } }) {
  const now = useNow(5000), quiet = now - agent.lastSeen > QUIET;
  return (
    <span className={cn("shrink-0 text-[10px]", quiet ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}
      title={quiet ? `No word from ${agent.name} since ${hm(agent.lastSeen)}: an agent acts only while its Claude session is working on something. It may be thinking, waiting for its user, or its session may have ended. Your messages wait for it: it gets them at its next step.` : `${agent.name} last called the bridge at ${clock(agent.lastSeen)}`}>
      {quiet ? `quiet ${ago(now - agent.lastSeen).replace(" ago", "")}` : `seen ${ago(now - agent.lastSeen)}`}
    </span>
  );
}
/** why a message is still "sent": who is to fetch it, and when it last looked */
function sentWhy(view: BridgeView, at: number, now = Date.now()) {
  const a = view.mode === "tab" ? null : view.agents.find(x => x.hub);
  const name = a?.name ?? view.agent ?? "The agent";
  if (!a) return `Sent ${ago(now - at)}, not fetched yet: ${name} gets messages at its next step (any bridge call).`;
  const quiet = now - a.lastSeen;
  return quiet > QUIET
    ? `Sent ${ago(now - at)}, not fetched yet: ${name} hasn't called the bridge since ${hm(a.lastSeen)}. An agent acts only while its Claude session is working; it gets the message at its next step, or ask its user to nudge it.`
    : `Sent ${ago(now - at)}, not fetched yet: ${name} was seen ${ago(quiet)} and gets messages at its next step (any bridge call).`;
}

/** an agent's report (T196): its lines, its table (the rows it points out marked), its findings; copied as text */
function ReportWindow({ report: r }: { report: BridgeReport | null }) {
  const copy = async () => {
    if (!r) return;
    try { await navigator.clipboard.writeText(reportText(r)); toast.success("Copied the report"); } catch { toast.error("Couldn't copy"); }
  };
  return (
    <Dialog open={!!r} onOpenChange={o => { if (!o) bridgeStore.openReport(null); }}>
      {r && (
        <DialogContent data-bridge-ui className="z-[75] flex max-h-[85vh] flex-col gap-3 sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><FileText className="size-4 text-violet-600" />{r.title}</DialogTitle>
            <DialogDescription>From {r.by}, {clock(r.at)}</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 gap-3 overflow-y-auto pr-1 text-sm">
            {r.intro && <p className="whitespace-pre-line">{r.intro}</p>}
            {r.table && (
              <div className="grid gap-1">
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-xs tabular-nums">
                    <thead className="bg-muted">
                      <tr>{r.table.columns.map((c, i) => <th key={i} className={cn("px-2 py-1.5 font-medium whitespace-nowrap", i ? "text-right" : "text-left")}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {r.table.rows.map((row, i) => (
                        <tr key={i} className={cn("border-t", r.table!.highlight?.includes(i) && "bg-emerald-50 font-medium dark:bg-emerald-950")}>
                          {row.map((c, j) => <td key={j} className={cn("px-2 py-1", j ? "text-right whitespace-nowrap" : "text-left")}>{c ?? "—"}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {r.table.note && <p className="text-xs text-muted-foreground">{r.table.note}</p>}
              </div>
            )}
            {r.findings && (
              <ul className="grid list-disc gap-1 pl-5">
                {r.findings.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            )}
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void copy()}><ClipboardCopy /> Copy as text</Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** the agent's pointer: where it is about to act (it glides there) */
function AgentCursor({ x, y, name, color, note }: { x: number; y: number; name: string; color: string; note: { text: string; at: number } | null }) {
  // (its last edit, T189: what it did, by the cursor, 4 s)
  const [now, setNow] = useState(() => note?.at ?? 0);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNow(Date.now()), 4100); return () => clearTimeout(t); }, [note]);
  const shown = note && now - note.at < 4000 ? note.text : null;
  return (
    <div className="pointer-events-none fixed z-[70] transition-[left,top] duration-300 ease-out" style={{ left: x, top: y }} aria-hidden>
      <svg width="20" height="20" viewBox="0 0 20 20" className="drop-shadow"><path d="M2 2 L17 9 L10 11 L8 18 Z" fill={color} stroke="white" strokeWidth="1.5" /></svg>
      <span className="ml-4 rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: color }}>{name}{shown ? ` · ${shown}` : ""}</span>
    </div>
  );
}

/** what the agent just did, a moment */
function Trace({ text, at }: { text: string; at: number }) {
  const [now, setNow] = useState(at);
  useEffect(() => { const t = setTimeout(() => setNow(Date.now()), 2600); return () => clearTimeout(t); }, [at]);
  if (now - at > 2500) return null;
  return <div className="pointer-events-none fixed bottom-14 left-1/2 z-[70] -translate-x-1/2 rounded-full bg-violet-600 px-3 py-1 text-xs text-white shadow-lg" role="status">{text}</div>;
}

/**
 * A note for the agent: drag a rectangle (or click a spot), write, send. With it: what is under it (roles and names), and
 * over the map, a picture of it and the map's point and what is there (the editor's `hitTest`).
 */
function Annotator({ onDone }: { onDone: () => void }) {
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onDone]);
  const send = async () => {
    if (!rect) return;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, world = bridgeToWorld(cx, cy);
    const hit = world ? bridgeState.get("hitTest")?.({ ...world, r: Math.max(rect.w, rect.h) / 2 }) as Record<string, unknown> | undefined : undefined;
    const simT = bridgeState.get("simT")?.({}) as number | undefined;
    try {
      await bridgeSend({
        kind: "annotation", note: note.trim(), rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) },
        ...(world ? { screenshot: crop(rect) } : {}),
        under: { roles: under(rect), ...(world ? { map: { x: Math.round(world.x * 10) / 10, y: Math.round(world.y * 10) / 10, ...(hit ?? {}) } } : {}) },
        url: location.href, ...(simT !== undefined ? { simT } : {}),
      });
      toast.success("Note sent to the agent");
      onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Not sent"); }
  };
  return (
    <div className="fixed inset-0 z-[65] cursor-crosshair bg-violet-500/5" role="dialog" aria-label="Annotate for the agent"
      onPointerDown={e => { if (rect) return; setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY }); }}
      onPointerMove={e => { if (drag) setDrag({ ...drag, x1: e.clientX, y1: e.clientY }); }}
      onPointerUp={() => {
        if (!drag) return;
        const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1), w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
        // (a click: a spot, a little square round it)
        setRect(w < 6 && h < 6 ? { x: drag.x0 - 12, y: drag.y0 - 12, w: 24, h: 24 } : { x, y, w, h });
        setDrag(null);
      }}>
      {!rect && <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet-600 px-3 py-1 text-xs text-white shadow">Drag round something, or click a spot · Esc to cancel</div>}
      {(drag || rect) && (() => {
        const r = rect ?? { x: Math.min(drag!.x0, drag!.x1), y: Math.min(drag!.y0, drag!.y1), w: Math.abs(drag!.x1 - drag!.x0), h: Math.abs(drag!.y1 - drag!.y0) };
        return <div className="pointer-events-none absolute rounded border-2 border-violet-600 bg-violet-500/10" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />;
      })()}
      {rect && (
        <div className="absolute flex w-80 gap-1.5 rounded-md border bg-background p-2 shadow-lg" style={{ left: Math.min(rect.x, window.innerWidth - 330), top: Math.min(rect.y + rect.h + 8, window.innerHeight - 60) }}
          onPointerDown={e => e.stopPropagation()}>
          <Input autoFocus value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void send(); }} placeholder="A note for the agent" aria-label="Note for the agent" className="h-8 text-xs" />
          <Button size="sm" className="h-8" onClick={() => void send()}>Send</Button>
        </div>
      )}
    </div>
  );
}

/** the map's picture under a rectangle of the page (client px), if it is over the map */
function crop(r: { x: number; y: number; w: number; h: number }): string | undefined {
  const c = bridgeCanvas();
  if (!c) return undefined;
  const b = c.getBoundingClientRect(), kx = c.width / b.width, ky = c.height / b.height;
  const x = Math.max(0, (r.x - b.left) * kx), y = Math.max(0, (r.y - b.top) * ky), w = Math.min(c.width - x, r.w * kx), h = Math.min(c.height - y, r.h * ky);
  if (w <= 1 || h <= 1) return undefined;
  const out = document.createElement("canvas"), k = Math.min(1, 800 / w);
  out.width = Math.round(w * k); out.height = Math.round(h * k);
  out.getContext("2d")!.drawImage(c, x, y, w, h, 0, 0, out.width, out.height);
  // (imagery from elsewhere can leave the map unreadable: no picture then)
  try { return out.toDataURL("image/png"); } catch { return undefined; }
}

/**
 * Whether the agents may change the plan (T189: the bridge's edit actions, each one undo step, shown by the agent's cursor):
 * not at all (by default), one sketch only (the one the Sketch window has open when it is chosen), or the plan and all its
 * sketches. The server keeps it and refuses edits it doesn't cover.
 */
function AgentEditsRow() {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get), p = view.allowEdits;
  const choose = (mode: string) => {
    if (mode === "sketch") {
      const scope = bridgeEditScope();
      if (!scope) { toast.error("Open a V2 plan first: its Sketch window's sketch is the one allowed"); return; }
      void bridgeAllowEdits({ mode: "sketch", ...scope });
    } else void bridgeAllowEdits(mode === "all" ? { mode: "all" } : { mode: "off" });
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span title="Agents attached here may change the plan through the bridge (lanes, connectors, signs, junctions, sketches): each change one undo step, saved as yours would be, shown by the agent's cursor and in the log">Allow agent edits</span>
      <select className="h-7 max-w-44 truncate rounded-md border bg-background px-1.5 text-xs" value={p.mode} onChange={e => choose(e.target.value)} aria-label="Allow agent edits">
        <option value="off">Off</option>
        <option value="sketch">{p.mode === "sketch" ? `Only “${p.name}”` : "This sketch only"}</option>
        <option value="all">Plan and its sketches</option>
      </select>
    </label>
  );
}

/**
 * The hub's agent tabs: whether agents may open tabs of their own here, a code for another agent, the agents attached
 * (revoke), every tab they have open (focus, take over, close), and the tabs asked for that the browser wouldn't open by
 * itself (pop-ups blocked: open with a click, or deny).
 */
function AgentTabsSection() {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 border-t pt-2">
      <AgentEditsRow />
      <label className="flex items-center justify-between gap-2 text-xs">
        <span title="Agents attached here may open tabs of their own in this browser (this app's pages only), each marked as theirs; you can watch, take over or close them">Allow agent tabs</span>
        <Switch checked={view.allowTabs} onCheckedChange={on => void bridgeAllowTabs(on)} aria-label="Allow agent tabs" />
      </label>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void bridgeAddAgent().catch(e => toast.error(e instanceof Error ? e.message : "No code"))} title="A code for another agent: it attaches here and works in tabs of its own">Add agent</Button>
        {view.agentCode && <AgentCode code={view.agentCode} />}
      </div>
      {view.requests.map(q => (
        <div key={q.ticket} className="grid gap-1 rounded-md border border-amber-400 bg-amber-50 p-2 text-xs dark:bg-amber-950" role="alert">
          <span><b style={{ color: q.color }}>{q.agent}</b> wants to open a tab: {q.label || q.url}{q.task ? ` · ${q.task}` : ""}</span>
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7 text-xs" onClick={() => { if (!bridgeOpenRequest(q)) toast.error("The browser blocked it again"); }}>Open</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void bridgeDenyRequest(q)}>Deny</Button>
          </div>
          <span className="text-[11px] text-muted-foreground">The browser blocked it as a pop-up. Allow pop-ups for this site and agent tabs open by themselves.</span>
        </div>
      ))}
      {view.agents.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
          <span className="text-[11px] text-muted-foreground">Agents</span>
          {view.agents.map(a => (
            <div key={a.id} className="flex items-center gap-1.5 text-xs">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
              <span className="min-w-0 flex-1 truncate">{a.name}{a.hub ? " (this page)" : " (its tabs)"}</span>
              <Seen agent={a} />
              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => void bridgeRevoke(a.id)} title="Let it go: its pairing ends; its tabs stay open, marked as left">Revoke</Button>
            </div>
          ))}
        </div>
      )}
      {view.tabs.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
          <span className="text-[11px] text-muted-foreground">Agent tabs</span>
          {view.tabs.map(t => (
            <div key={t.pageId} className="flex items-center gap-1.5 text-xs" title={t.url}>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
              <span className="min-w-0 flex-1 truncate">{t.agentName}{t.task ? ` · ${t.task}` : ""} · {t.label || t.title || t.url}</span>
              <span className="text-[10px] text-muted-foreground">{t.left ? "left" : t.paused ? "paused" : t.connected ? "live" : "…"}</span>
              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => { if (!bridgeFocusTab(t)) toast("Switch to it from the browser's tab bar", { description: "This browser won't let a page bring another tab forward." }); }}>Focus</Button>
              {!t.left && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => void bridgePauseTab(t.pageId, !t.paused)}>{t.paused ? "Resume" : "Pause"}</Button>}
              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => void bridgeCloseTab(t)}>Close</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An agent's tab, marked as theirs: a bar across the top in the agent's colour ("Ramona is working here · T34", take
 * over / give back, close), its title prefixed ("● Ramona · T34 — …") and its favicon in the agent's colour.
 */
function AgentTabChrome() {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  const t = view.tab!;
  const prefix = `● ${t.agent}${t.task ? ` · ${t.task}` : ""} — `;
  // (the title kept prefixed as the page changes it; the favicon a dot in the agent's colour)
  useEffect(() => {
    const fix = () => { if (!document.title.startsWith(prefix)) document.title = prefix + document.title.replace(/^● [^—]* — /, ""); };
    fix();
    const head = document.querySelector("head");
    const mo = new MutationObserver(fix);
    if (head) mo.observe(head, { subtree: true, childList: true, characterData: true });
    return () => { mo.disconnect(); document.title = document.title.replace(/^● [^—]* — /, ""); };
  }, [prefix]);
  useEffect(() => {
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const g = c.getContext("2d")!; g.fillStyle = t.color; g.beginPath(); g.arc(16, 16, 14, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fff"; g.font = "bold 18px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t.agent.slice(0, 1).toUpperCase(), 16, 17);
    const link = document.createElement("link"); link.rel = "icon"; link.href = c.toDataURL("image/png"); link.setAttribute("data-bridge-icon", "");
    const old = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]:not([data-bridge-icon])')];
    old.forEach(l => l.setAttribute("data-bridge-was", l.rel)); old.forEach(l => { l.rel = "bridge-was-icon"; });
    document.head.appendChild(link);
    return () => { link.remove(); old.forEach(l => { l.rel = l.getAttribute("data-bridge-was") ?? "icon"; }); };
  }, [t.color, t.agent]);
  return (
    <>
    {/* (a frame round the window in the agent's colour, the page's own controls left free; the bar under the header, in the middle) */}
    <div className="pointer-events-none fixed inset-0 z-[69] border-[3px]" style={{ borderColor: t.color }} aria-hidden />
    <div className="fixed top-14 left-1/2 z-[70] flex h-7 max-w-[min(640px,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-full px-3 text-xs text-white shadow-lg" style={{ background: t.color }} role="status" aria-label="Agent tab">
      <Bot className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">
        {t.closed ? `${t.agent}'s tab, closed: you can close it` : t.left ? `${t.agent} left: this tab is yours now` : t.paused ? `You took over from ${t.agent}: its commands are paused here` : `${t.agent} is working here`}
        {t.task ? ` · ${t.task}` : ""}{t.label ? ` · ${t.label}` : ""}
      </span>
      {!t.left && !t.closed && (
        <button className="flex items-center gap-1 rounded bg-white/20 px-2 py-0.5 hover:bg-white/30" onClick={() => void bridgeTakeOver(!t.paused)} title={t.paused ? `Let ${t.agent} carry on here` : `Pause ${t.agent}'s commands here, to work in this tab yourself`}>
          {t.paused ? <><Play className="size-3" /> Give back</> : <><Hand className="size-3" /> Take over</>}
        </button>
      )}
      <button className="rounded bg-white/20 px-2 py-0.5 hover:bg-white/30" onClick={() => void bridgeDisconnect()} title="End this tab's pairing and close it">Close</button>
    </div>
    </>
  );
}
