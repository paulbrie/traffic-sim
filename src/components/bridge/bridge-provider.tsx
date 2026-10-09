"use client";

/**
 * The Claude bridge in the page (docs/claude-bridge.md), on every page, idle until an admin pairs it (Connect Claude, in
 * the account menu): its panel (the code to give the agent, who is attached, disconnect, every command it ran, a message
 * box, the pen), a badge while an agent is attached, the agent's cursor moving to what it acts on and a line saying what
 * it did, and annotations: a rectangle drawn (or a spot clicked) with a note, sent to the agent with what is under it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bot, PenLine, Send, Unplug, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { bridgeCanvas, bridgeState, bridgeToWorld } from "@/state/bridge-registry";
import { bridgeDisconnect, bridgeHello, bridgePair, bridgeResume, bridgeSend, bridgeStore, setBridgeNavigate } from "@/state/bridge-client";
import { under } from "./a11y";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function BridgeProvider() {
  const view = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  const router = useRouter(), pathname = usePathname();
  const [annotating, setAnnotating] = useState(false);
  const paired = view.phase === "waiting" || view.phase === "attached";

  useEffect(() => { setBridgeNavigate(path => router.push(path)); bridgeResume(); }, [router]);
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

  if (!view.open && !paired && view.phase !== "lost") return null;
  return (
    <div data-bridge-ui>
      {view.open ? <BridgePanel onAnnotate={() => setAnnotating(true)} /> : paired || view.phase === "lost" ? (
        // (while paired, always in sight: who is attached, one click to the panel)
        <button className={cn("fixed right-3 bottom-3 z-[60] flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs shadow-md",
          view.phase === "attached" ? "border-violet-400 bg-violet-50 text-violet-900 dark:bg-violet-950 dark:text-violet-100" : "bg-background text-muted-foreground")}
          onClick={() => bridgeStore.show(true)}>
          <Bot className="size-3.5" />
          {view.phase === "attached" ? `${view.agent} is working here` : view.phase === "lost" ? "Claude disconnected" : `Waiting for Claude · ${view.code}`}
        </button>
      ) : null}
      {view.phase === "attached" && view.cursor && <AgentCursor x={view.cursor.x} y={view.cursor.y} name={view.agent ?? "Claude"} />}
      {view.phase === "attached" && view.trace && <Trace text={view.trace.text} at={view.trace.at} />}
      {annotating && <Annotator onDone={() => setAnnotating(false)} />}
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
    try { await bridgeSend({ kind: "message", text: t }); setText(""); toast.success("Sent to the agent"); } catch (e) { toast.error(e instanceof Error ? e.message : "Not sent"); }
  };
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [view.log.length]);
  return (
    <div className="fixed right-3 bottom-3 z-[60] flex max-h-[70vh] w-96 flex-col rounded-lg border bg-background shadow-xl" role="dialog" aria-label="Claude bridge">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Bot className="size-4 text-violet-600" />
        <span className="text-sm font-medium">Claude bridge</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {view.phase === "attached" ? `${view.agent} attached` : view.phase === "waiting" ? "waiting for the agent" : view.phase === "pairing" ? "pairing…" : view.phase === "lost" ? "disconnected" : "not connected"}
        </span>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Close the panel" onClick={() => bridgeStore.show(false)}><X /></Button>
      </div>
      <div className="grid gap-2 p-3">
        {!paired ? (
          <>
            <p className="text-xs text-muted-foreground">An agent (a Claude session with the bridge) can read this page, act in it — you see its cursor and every command — and get your notes. Pair, then give it the code.</p>
            {view.error && <p className="text-xs text-red-600">{view.error}</p>}
            <Button size="sm" onClick={() => void bridgePair()} disabled={view.phase === "pairing"}>Pair this page</Button>
          </>
        ) : (
          <>
            {view.phase === "waiting" && (
              <div className="grid gap-1 rounded-md bg-muted p-2 text-center">
                <span className="text-[11px] text-muted-foreground">Give the agent this code (valid 10 minutes)</span>
                <span className="font-mono text-2xl tracking-[0.3em] tabular-nums">{view.code}</span>
              </div>
            )}
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="flex-1" onClick={onAnnotate} title="Draw a rectangle (or click a spot) and write a note for the agent (A)"><PenLine /> Annotate</Button>
              <Button size="sm" variant="outline" onClick={() => void bridgeDisconnect()} title="End the pairing: the agent can't act here any more"><Unplug /> Disconnect</Button>
            </div>
            <div className="flex gap-1.5">
              <Input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void send(); }} placeholder="A message to the agent" aria-label="Message to the agent" className="h-8 text-xs" />
              <Button size="icon-sm" className="size-8" aria-label="Send the message" disabled={!text.trim()} onClick={() => void send()}><Send /></Button>
            </div>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** the agent's pointer: where it is about to act (it glides there) */
function AgentCursor({ x, y, name }: { x: number; y: number; name: string }) {
  return (
    <div className="pointer-events-none fixed z-[70] transition-[left,top] duration-300 ease-out" style={{ left: x, top: y }} aria-hidden>
      <svg width="20" height="20" viewBox="0 0 20 20" className="drop-shadow"><path d="M2 2 L17 9 L10 11 L8 18 Z" fill="#7c3aed" stroke="white" strokeWidth="1.5" /></svg>
      <span className="ml-4 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-medium text-white">{name}</span>
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
