"use client";

/**
 * A ticket filed from the Claude bridge panel (ticket #95): a title, a description and the page's data to go with it, each
 * kind a checkbox (the map's picture, the selection and its car's explanation, the moment's replay data, the run, the
 * sketch, the console…), the kinds this page has only. The data is taken when the form opens: the moment you meant, not
 * the one a minute of typing later. It goes to the box's admin (its tickets: the same host, the admin's own sign-in), each
 * kind a file attached to the ticket.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { TicketPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { reportText } from "@/lib/bridge-report";
import { bridgeCanvas, bridgeState, bridgeUi } from "@/state/bridge-registry";
import { bridgeConsole, bridgeStore } from "@/state/bridge-client";
import { snapshot } from "./a11y";

/** the admin the tickets go to, and its project (the box's admin, same host: its session cookie goes with the request) */
const ADMIN = (process.env.NEXT_PUBLIC_ADMIN_URL ?? "/admin").replace(/\/$/, "");
const PROJECT = process.env.NEXT_PUBLIC_TICKETS_PROJECT ?? "trafficsim";
const KEPT = "trafficsim.bridgeTicket.kinds";

/** a kind of data: what it is, whether this page has it, and it as a file (null: nothing there just now) */
interface Kind { id: string; label: string; hint: string; on: boolean; has: () => boolean; take: () => Promise<File | null> }
const json = (name: string, v: unknown) => (v === undefined || v === null ? null : new File([JSON.stringify(v, null, 1)], name, { type: "application/json" }));
const text = (name: string, t: string | null | undefined) => (t ? new File([t], name, { type: "text/plain" }) : null);
const state = async (key: string) => { const f = bridgeState.get(key); return f ? await f({}) : undefined; };

const KINDS: Kind[] = [
  { id: "map", label: "Picture of the map", hint: "map.png, as it shows now", on: true, has: () => !!bridgeCanvas(),
    take: () => new Promise(res => {
      const c = bridgeCanvas();
      if (!c) return res(null);
      // (imagery from elsewhere can leave the map unreadable: no picture then)
      try { c.toBlob(b => res(b ? new File([b], "map.png", { type: "image/png" }) : null), "image/png"); } catch { res(null); }
    }) },
  { id: "selection", label: "Selection and its car's explanation", hint: "selection.json: lanes, connectors, junctions, the car picked and why it does what it does", on: true,
    has: () => !!bridgeState.get("selection"), take: async () => json("selection.json", await state("selection")) },
  { id: "moment", label: "Replay data at the moment shown", hint: "moment.txt, as Copy replay data: the cars in view, the lights, a minute's events", on: true,
    has: () => !!bridgeState.get("moment"), take: async () => text("moment.txt", (await state("moment")) as string | null) },
  { id: "simulation", label: "The whole run", hint: "simulation.txt, as Copy simulation data: the sketch, the cars, the jumps, the last minute's events (large)", on: false,
    has: () => !!bridgeState.get("simulation"), take: async () => text("simulation.txt", (await state("simulation")) as string | null) },
  { id: "stats", label: "Simulation stats", hint: "stats.json", on: false, has: () => !!bridgeState.get("stats"), take: async () => json("stats.json", await state("stats")) },
  { id: "problems", label: "Problems", hint: "problems.json: the simulation's own console", on: false, has: () => !!bridgeState.get("problems"), take: async () => json("problems.json", await state("problems")) },
  { id: "sketch", label: "The sketch", hint: "sketch.json: every lane, connector, junction…", on: false, has: () => !!bridgeState.get("sketchJson"), take: async () => json("sketch.json", await state("sketchJson")) },
  { id: "editor", label: "Editor state", hint: "editor.json: the view, the run, the experiment, the UI (panels, tools, options)", on: false,
    has: () => ["view", "run", "experiment"].some(k => bridgeState.get(k)) || !!bridgeUi(),
    take: async () => json("editor.json", { view: await state("view"), run: await state("run"), experiment: await state("experiment"), ui: bridgeUi()?.snapshot() }) },
  { id: "console", label: "Browser console", hint: "console.json: the last uncaught errors, rejections, console errors and warnings", on: false,
    has: () => true, take: async () => { const c = bridgeConsole(); return c.length ? json("console.json", c) : null; } },
  { id: "page", label: "The page's outline", hint: "page.txt: its accessibility tree, as an agent reads it", on: false,
    has: () => true, take: async () => text("page.txt", `${location.href}\n${document.title}\n\n${snapshot(document.body)}`) },
  { id: "log", label: "Bridge activity", hint: "bridge-log.json: the agents' commands, your messages and notes", on: false,
    has: () => bridgeStore.get().log.length > 0, take: async () => json("bridge-log.json", bridgeStore.get().log) },
  { id: "reports", label: "Agents' reports", hint: "reports.txt: the reports in the panel", on: false,
    has: () => bridgeStore.get().reports.length > 0, take: async () => text("reports.txt", bridgeStore.get().reports.map(reportText).join("\n\n")) },
];

const kept = (): Set<string> | null => { try { const v = localStorage.getItem(KEPT); return v ? new Set(JSON.parse(v) as string[]) : null; } catch { return null; } };
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** the panel's button: opens the form */
export function NewTicketButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="icon-sm" className="size-7" aria-label="New ticket" title="New ticket: a title, a description and this page's data to go with it" onClick={() => setOpen(true)}><TicketPlus /></Button>
      {open && <NewTicket onClose={() => setOpen(false)} />}
    </>
  );
}

function NewTicket({ onClose }: { onClose: () => void }) {
  useSyncExternalStore(bridgeStore.subscribe, bridgeStore.get, bridgeStore.get);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [withUrl, setWithUrl] = useState(true);
  const [url] = useState(() => location.href);
  // (the kinds this page has, and the data of each taken now: its file, or none there)
  const [kinds] = useState(() => KINDS.filter(k => k.has()));
  const [files, setFiles] = useState<Record<string, File | null | "…">>(() => Object.fromEntries(kinds.map(k => [k.id, "…"])));
  const [picked, setPicked] = useState<Set<string>>(() => { const k = kept(); return new Set(kinds.filter(x => (k ? k.has(x.id) : x.on)).map(x => x.id)); });
  const [busy, setBusy] = useState(false);
  const [signIn, setSignIn] = useState(false);
  useEffect(() => {
    for (const k of kinds) void k.take().catch(() => null).then(f => setFiles(all => ({ ...all, [k.id]: f })));
  }, [kinds]);
  const toggle = (id: string, on: boolean) => setPicked(all => { const n = new Set(all); if (on) n.add(id); else n.delete(id); return n; });
  const going = kinds.filter(k => picked.has(k.id) && files[k.id] instanceof File);
  const waiting = kinds.some(k => picked.has(k.id) && files[k.id] === "…");

  const send = async () => {
    if (!title.trim() || busy || waiting) return;
    setBusy(true); setSignIn(false);
    try { localStorage.setItem(KEPT, JSON.stringify([...picked])); } catch {}
    const body = new FormData();
    body.set("title", title.trim());
    body.set("description", [description.trim(), withUrl ? `Page: ${url}` : ""].filter(Boolean).join("\n\n"));
    for (const k of going) body.append("files", files[k.id] as File);
    try {
      const r = await fetch(`${ADMIN}/api/projects/${encodeURIComponent(PROJECT)}/tasks`, { method: "POST", body, credentials: "include" });
      if (r.status === 401) { setSignIn(true); return; }
      const out = (await r.json().catch(() => null)) as { id?: number; attached?: number; fileError?: string; url?: string; error?: string } | null;
      if (!r.ok || !out?.id) throw new Error(out?.error ?? `The admin said ${r.status}`);
      const board = out.url ?? `${ADMIN}/projects/${PROJECT}/tasks`;
      toast.success(`Ticket #${out.id} created`, {
        description: out.fileError ? `Some files weren't kept: ${out.fileError}` : out.attached ? `${out.attached} file${out.attached === 1 ? "" : "s"} attached` : undefined,
        action: { label: "Open", onClick: () => window.open(board, "_blank") },
      });
      onClose();
    } catch (e) { toast.error(e instanceof Error ? e.message : "The ticket wasn't created"); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-bridge-ui className="z-[75] flex max-h-[90vh] flex-col gap-3 sm:max-w-xl" onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><TicketPlus className="size-4 text-violet-600" />New ticket</DialogTitle>
          <DialogDescription>For {PROJECT}, in the admin&apos;s tickets. The page&apos;s data is as it was when this opened.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 overflow-y-auto pr-1">
          <Input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void send(); }} placeholder="Title" aria-label="Title" maxLength={500} />
          <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What's wrong, or wanted" aria-label="Description" className="max-h-60 min-h-24 text-sm" />
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-xs text-muted-foreground">Attach</legend>
            <label className="flex items-start gap-2 text-sm" title={url}>
              <input type="checkbox" className="mt-1 accent-violet-600" checked={withUrl} onChange={e => setWithUrl(e.target.checked)} />
              <span className="min-w-0 flex-1"><span>Page address</span><span className="block truncate text-xs text-muted-foreground">in the description: {url}</span></span>
            </label>
            {kinds.map(k => {
              const f = files[k.id];
              return (
                <label key={k.id} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1 accent-violet-600" checked={picked.has(k.id)} disabled={f === null} onChange={e => toggle(k.id, e.target.checked)} />
                  <span className="min-w-0 flex-1">
                    <span className={f === null ? "text-muted-foreground" : undefined}>{k.label}</span>
                    <span className="block text-xs text-muted-foreground">{k.hint}</span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{f === "…" ? "…" : f ? size(f.size) : "none here"}</span>
                </label>
              );
            })}
          </fieldset>
          {signIn && (
            <p className="rounded-md border border-amber-400 bg-amber-50 p-2 text-xs dark:bg-amber-950" role="alert">
              The admin doesn&apos;t know you in this browser: <a className="underline" href={`${ADMIN}/login`} target="_blank" rel="noreferrer">sign in to it</a> (a new tab), then Create again. What you wrote stays here.
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">{going.length + (withUrl ? 1 : 0) ? `${going.length} file${going.length === 1 ? "" : "s"}${withUrl ? " and the page's address" : ""}` : "Nothing attached"}</span>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!title.trim() || busy || waiting} onClick={() => void send()}>{busy ? "Creating…" : waiting ? "Taking the data…" : "Create ticket"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
