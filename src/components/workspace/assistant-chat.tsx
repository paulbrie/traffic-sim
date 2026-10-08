"use client";

import { useEffect, useRef, useState } from "react";
import { useDeepSubject } from "subjecto/react";
import { Check, MessageCircle, RotateCcw, Send, Square, Wrench, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { Network } from "@/engine/types";
import { sanitizeNetwork } from "@/engine/validate";
import { basePath } from "@/lib/base-path";
import { commit, network$, settings$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { replayMomentText } from "@/state/replay-copy";
import { readSteps, type WalkStep } from "@/lib/walkthrough";
import { ChatMarkdown } from "./chat-markdown";
import { Walkthrough } from "./walkthrough";
import { ResizeEdges, useFloatingBox } from "./floating-box";

/** one step the assistant took (a file read, a command run…) */
interface ToolStep { name: string; detail: string }
interface Msg {
  role: "user" | "assistant";
  text: string;
  tools?: ToolStep[];
  /** a changed plan the assistant wrote, offered to apply; `applied` once it was */
  plan?: Network; applied?: boolean;
  /** the assistant's walkthrough of its change, and how many of its steps are made */
  steps?: WalkStep[]; made?: number;
  error?: string | null; cost?: number | null; busy?: boolean;
}
interface Chat { session: string | null; msgs: Msg[] }

const MAX_PROBLEMS = 400;

const keyOf = (planId: string) => `assistant:${planId}`;
const load = (planId: string): Chat => {
  try { const c = JSON.parse(sessionStorage.getItem(keyOf(planId)) ?? ""); if (c && Array.isArray(c.msgs)) return { session: c.session ?? null, msgs: c.msgs.map((m: Msg) => ({ ...m, busy: false })) }; } catch { /* none yet */ }
  return { session: null, msgs: [] };
};
// (changed plans can be big: they are kept for this page only, not in session storage)
const save = (planId: string, c: Chat) => { try { sessionStorage.setItem(keyOf(planId), JSON.stringify({ session: c.session, msgs: c.msgs.map(m => ({ ...m, plan: undefined, applied: m.plan ? m.applied ?? false : undefined, steps: m.steps?.map(st => ({ ...st, network: null })) })) })); } catch { /* full: keep it in memory */ } };

/** what the assistant is told about the moment: what's on screen, the simulation's problems, the plan's warnings */
function contextText(): string {
  const u = ui.getValue(), sim = simController.sim, c = simController.compiled;
  const parts = [`# Plan ${u.planId}, revision ${u.save.revision} (${u.save.status === "saved" ? "saved" : "with unsaved edits"})`,
    `Selected: ${u.selection ? JSON.stringify(u.selection) : "nothing"}${u.multi.length || u.extra.length ? ` (and ${JSON.stringify([...u.multi, ...u.extra])})` : ""}`];
  if (sim) {
    parts.push(`## On screen\n${replayMomentText()}`);
    const ps = sim.problems.slice(-MAX_PROBLEMS);
    parts.push(`## Simulation problems (${sim.problems.length}${sim.problems.length > ps.length ? `, the last ${ps.length}` : ""})\n\`\`\`json\n${JSON.stringify(ps)}\n\`\`\``);
  } else parts.push("The simulation isn't running.");
  parts.push(`## Plan warnings (${c.warnings.length})\n${c.warnings.map(w => `- ${w}`).join("\n") || "none"}`);
  return parts.join("\n\n");
}

/**
 * The assistant's chat bubble on the map (admins, on a development server): Claude Code on the server, told
 * about the plan as it is open (unsaved edits included) and the moment on screen with each message. A plan it
 * changes comes back to apply here, as one step that can be undone.
 */
export function AssistantChat({ planName }: { planName: string }) {
  const [planId] = useDeepSubject(ui, "planId");
  const [readOnly] = useDeepSubject(ui, "readOnly");
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState<Chat>(() => load(planId));
  const [draft, setDraft] = useState("");
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = chat.msgs.some(m => m.busy);
  const { panel, style, placed, start, reset } = useFloatingBox("assistant:box", 300, 240);

  const update = (f: (c: Chat) => Chat) => setChat(c => { const n = f(c); save(planId, n); return n; });
  const patchLast = (f: (m: Msg) => Msg) => update(c => (c.msgs.length ? { ...c, msgs: [...c.msgs.slice(0, -1), f(c.msgs[c.msgs.length - 1])] } : c));

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat, open]);
  useEffect(() => () => abort.current?.abort(), []);

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    update(c => ({ ...c, msgs: [...c.msgs, { role: "user", text: message }, { role: "assistant", text: "", tools: [], busy: true }] }));
    const ac = new AbortController();
    abort.current = ac;
    const u = ui.getValue(), net = network$.getValue();
    let error: string | null = null, cost: number | null = null;
    try {
      const res = await fetch(`${basePath}/api/plans/${planId}/assistant`, {
        method: "POST", signal: ac.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message, session: chat.session, plan: { id: planId, name: planName, revision: u.save.revision },
          network: { ...net, buildings: undefined }, settings: settings$.getValue(), context: contextText(),
        }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `The server said ${res.status}.`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.type === "session") update(c => ({ ...c, session: e.id }));
          else if (e.type === "text") patchLast(m => ({ ...m, text: m.text + e.text }));
          else if (e.type === "tool") patchLast(m => ({ ...m, tools: [...(m.tools ?? []), { name: e.name, detail: e.detail }] }));
          else if (e.type === "plan") { try { const plan = sanitizeNetwork(e.network); patchLast(m => ({ ...m, plan })); } catch { error = "The changed plan it wrote couldn't be read."; } }
          else if (e.type === "steps") { const steps = readSteps(e.steps); if (steps.length) patchLast(m => ({ ...m, steps, made: 0 })); }
          else if (e.type === "done") { error = error ?? e.error; cost = e.cost; }
        }
      }
    } catch (e) {
      error = ac.signal.aborted ? "Stopped." : (e as Error).message;
    }
    abort.current = null;
    patchLast(m => ({ ...m, busy: false, error, cost }));
  };

  const apply = (i: number) => {
    const m = chat.msgs[i];
    if (!m.plan || readOnly) return;
    // (buildings weren't sent: keep the plan's own)
    commit({ ...m.plan, buildings: network$.getValue().buildings });
    update(c => ({ ...c, msgs: c.msgs.map((x, j) => (j === i ? { ...x, applied: true, made: x.steps?.length } : x)) }));
    toast.success("Applied the assistant's changes", { description: "Undo (⌘Z / Ctrl+Z) takes them back." });
  };

  const madeSteps = (i: number, upTo: number, all: boolean) =>
    update(c => ({ ...c, msgs: c.msgs.map((x, j) => (j === i ? { ...x, made: Math.max(x.made ?? 0, upTo), applied: x.applied || all } : x)) }));

  const fresh = () => { abort.current?.abort(); update(() => ({ session: null, msgs: [] })); };

  if (!open) return (
    <Button size="icon" className="absolute bottom-3 left-3 z-20 size-10 rounded-full shadow-md" aria-label="Ask the assistant" title="Ask the assistant (Claude Code on the dev server)" onClick={() => setOpen(true)}>
      <MessageCircle />
      {busy && <span className="absolute -top-0.5 -right-0.5 size-3 animate-pulse rounded-full bg-amber-500" />}
    </Button>
  );

  return (
    <div ref={panel} style={style} role="dialog" aria-label="Assistant"
      className={`absolute z-20 flex flex-col overflow-hidden rounded-lg border bg-background shadow-lg ${placed ? "" : "bottom-3 left-3 h-[min(620px,calc(100%-1.5rem))] w-[min(420px,calc(100%-1.5rem))]"}`}>
      <ResizeEdges start={start} />
      <div className="flex cursor-move touch-none items-center gap-2 border-b px-3 py-2 select-none" title="Drag to move · double-click to put back"
        onPointerDown={e => { if (!(e.target as HTMLElement).closest("button")) start(e, null); }} onDoubleClick={e => { if (!(e.target as HTMLElement).closest("button")) reset(); }}>
        <MessageCircle className="size-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium">Assistant <span className="text-xs font-normal text-muted-foreground">· Claude Code on the dev server</span></span>
        <Button size="icon-sm" variant="ghost" aria-label="New conversation" title="New conversation" onClick={fresh}><RotateCcw /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close" title="Close (the conversation is kept)" onClick={() => setOpen(false)}><X /></Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
        {!chat.msgs.length && (
          <p className="text-xs text-muted-foreground">
            Ask about this plan or the simulation, or ask for changes. With each message the assistant gets the plan as it is open here (unsaved edits too), what is on screen, the selection, the simulation&apos;s problems and the plan&apos;s warnings. Changes to the plan come back here to apply; it can also change the app&apos;s code, like in a terminal.
          </p>
        )}
        {chat.msgs.map((m, i) => m.role === "user" ? (
          <div key={i} className="ml-8 rounded-lg bg-primary px-3 py-2 whitespace-pre-wrap text-primary-foreground">{m.text}</div>
        ) : (
          <div key={i} className="mr-4 space-y-1.5">
            {!!m.tools?.length && (
              <div className="space-y-0.5">
                {m.tools.map((t, k) => (
                  <div key={k} className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" title={t.detail}>
                    <Wrench className="size-3 shrink-0" /><span className="shrink-0 font-medium">{t.name}</span><span className="truncate font-mono">{t.detail}</span>
                  </div>
                ))}
              </div>
            )}
            {m.text && <ChatMarkdown text={m.text} />}
            {m.busy && <div className="text-xs text-muted-foreground animate-pulse">Working…</div>}
            {m.error && <div className="text-xs text-red-600 dark:text-red-400">{m.error}</div>}
            {m.plan && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1.5 text-xs">
                <span className="flex-1">It changed the plan.</span>
                {m.applied ? <span className="flex items-center gap-1 text-muted-foreground"><Check className="size-3.5" /> Applied</span>
                  : <Button size="sm" className="h-7" disabled={readOnly} title={readOnly ? "This plan is view-only for you" : "Apply to the plan (can be undone)"} onClick={() => apply(i)}>Apply</Button>}
              </div>
            )}
            {!!m.steps?.length && !m.busy && <Walkthrough steps={m.steps} made={m.made ?? 0} readOnly={readOnly} onMade={(upTo, all) => madeSteps(i, upTo, all)} />}
            {m.applied === false && !m.plan && <div className="text-xs text-muted-foreground">(The changed plan it wrote is gone since the page reloaded.)</div>}
            {m.cost != null && !m.busy && <div className="text-[10px] text-muted-foreground tabular">${m.cost.toFixed(3)}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="flex items-end gap-2 border-t p-2" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} autoFocus aria-label="Message to the assistant"
          placeholder="Ask about the plan or the simulation…  (Enter sends, Shift+Enter a new line)"
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } else if (e.key === "Escape") setOpen(false); }}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-md border bg-transparent px-2.5 py-2 text-sm outline-none field-sizing-content placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50" />
        {busy
          ? <Button type="button" size="icon" variant="outline" aria-label="Stop" title="Stop" onClick={() => abort.current?.abort()}><Square /></Button>
          : <Button type="submit" size="icon" aria-label="Send" disabled={!draft.trim()}><Send /></Button>}
      </form>
    </div>
  );
}
