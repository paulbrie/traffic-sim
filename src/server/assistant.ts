// The assistant in the plan editor's chat bubble: Claude Code (the `claude` CLI) run on the server, in this
// project's folder, with the plan as it is open in the editor. It reads and changes code and runs scripts like
// in a terminal session, so it is for admins only (UserIsAdmin), only on a server started with `npm run dev`
// (ENV=DEV), and only once switched on with ASSISTANT=on (.env.local).
import "server-only";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readSteps, type WalkStep } from "@/lib/walkthrough";
import type { UserIsAdmin } from "./proofs/user-is-admin";

/** switched on (ASSISTANT=on) on a development server (`npm run dev` sets ENV=DEV); never in production */
export const assistantEnabled = () => /^(on|true|1|yes)$/i.test(process.env.ASSISTANT?.trim() ?? "") && process.env.ENV === "DEV" && process.env.NODE_ENV === "development";

/** what the editor sends with each message: the plan as open (unsaved edits included) and the moment on screen */
export interface AssistantTurn {
  message: string;
  /** the conversation to carry on (from an earlier `session` event), or null for a new one */
  session: string | null;
  plan: { id: string; name: string; revision: number };
  network: unknown;
  settings: unknown;
  /** the replay moment (see replayMomentText), the simulation's problems and the plan's warnings, as text */
  context: string;
}

/** what the stream sends the editor, one JSON object per line */
export type AssistantEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "plan"; network: unknown }
  | { type: "steps"; steps: WalkStep[] }
  | { type: "done"; cost: number | null; error: string | null };

const ROOT = join(tmpdir(), "trafficsim-assistant");
const MAX_TURN = 30 * 60_000;

const SYSTEM = `You are answering from the chat bubble in Gridlock's plan editor (this project's web app), not a terminal.
The user is looking at a plan on the map. Each message names a folder holding the plan exactly as it is open in the editor
(network.json, unsaved edits included; buildings left out), its settings (settings.json) and context.md: the moment on
screen (vehicles in view, lights, parking, crossings, selection, stats), the simulation's problems and the plan's warnings.
To simulate it, write a throwaway script like scripts/_pp.ts that compiles network.json with src/engine and runs Sim.
To change the plan, write the whole changed network (same format as network.json) to network.next.json in that folder:
the editor offers it to the user to apply (it can be undone). Never write plans to the database yourself.
You may read and change the project's code as usual when asked to.
Your replies are rendered as Markdown (lists, bold, code, small tables) in a chat panel: keep them short; ids (n_…, l_…, pk_…,
x_…, J12) become links that select the thing on the map, also inside backticks, so name things by their ids.
When you change the plan, also walk the user through it: write steps.json in that folder, an array of
{ "title": "a few words", "text": "what this step does and why (Markdown, ids)", "focus": ["n_…", "l_…"],
  "network": "step1.json" }. The chat shows the steps one at a time; each takes the map to its focus ids (framed and
selected) and, when it has "network" (a file in that folder holding the whole plan as it is after the step, same format
as network.json; steps build on each other), lets the user make that step. Start with a step showing the problem (no
"network"); the last step's network should be network.next.json's. Keep each text to a few sentences.`;

/** the walkthrough the assistant wrote (steps.json), with each step's plan file read in */
async function readWalkthrough(dir: string): Promise<WalkStep[]> {
  const raw: unknown = JSON.parse(await readFile(join(dir, "steps.json"), "utf8"));
  if (!Array.isArray(raw)) return [];
  const withPlans = await Promise.all(raw.map(async s => {
    const file = s && typeof s === "object" ? (s as { network?: unknown }).network : null;
    if (typeof file !== "string") return s;
    // (only files in the folder itself)
    const network = await readFile(join(dir, basename(file)), "utf8").then(t => JSON.parse(t) as unknown, () => null);
    return { ...(s as object), network };
  }));
  return readSteps(withPlans);
}

/** a short line saying what a tool call does, for the chat */
function toolDetail(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const short = (v: string) => (v.length > 140 ? `${v.slice(0, 140)}…` : v);
  if (name === "Bash") return short(s(input.description) || s(input.command));
  if (name === "Read" || name === "Edit" || name === "Write") return s(input.file_path).replace(`${process.cwd()}/`, "");
  if (name === "Grep" || name === "Glob") return short(s(input.pattern));
  return short(s(input.description) || s(input.prompt) || "");
}

/**
 * Runs one message through Claude Code and streams what happens (text as it is written, tool calls, a changed
 * plan, the end) as AssistantEvents. `signal` stops it (the editor's Stop button, or the page going away).
 */
export function runAssistant<U>(turn: AssistantTurn, user: { email: string }, signal: AbortSignal, _admin: UserIsAdmin<U>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: AssistantEvent) => { if (!closed) try { controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`)); } catch { closed = true; } };
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } };

      const dir = join(ROOT, turn.plan.id.replace(/[^0-9a-f-]/gi, ""), `${Date.now().toString(36)}`);
      const next = join(dir, "network.next.json");
      try {
        await mkdir(dir, { recursive: true });
        await Promise.all([
          writeFile(join(dir, "network.json"), JSON.stringify(turn.network)),
          writeFile(join(dir, "settings.json"), JSON.stringify(turn.settings, null, 1)),
          writeFile(join(dir, "context.md"), turn.context),
        ]);
      } catch (e) {
        send({ type: "done", cost: null, error: `Couldn't write the plan for the assistant: ${(e as Error).message}` });
        close();
        return;
      }

      const prompt = `[Plan "${turn.plan.name}" (${turn.plan.id}), revision ${turn.plan.revision}, as open in the editor of ${user.email}: ${dir}]\n\n${turn.message}`;
      const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--permission-mode", process.env.ASSISTANT_PERMISSION_MODE || "auto", "--append-system-prompt", SYSTEM, "--add-dir", dir];
      if (turn.session) args.push("--resume", turn.session);
      if (process.env.ASSISTANT_MODEL) args.push("--model", process.env.ASSISTANT_MODEL);
      // (the dev server's own variables are not the assistant's: it runs scripts and npm like in a terminal)
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith("__NEXT") || k.startsWith("NEXT_RUNTIME") || k === "NODE_ENV" || k === "CLAUDECODE" || k === "CLAUDE_CODE_ENTRYPOINT") delete env[k];
      const child = spawn(process.env.ASSISTANT_CLI || "claude", args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });

      const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
      signal.addEventListener("abort", stop);
      const timer = setTimeout(stop, MAX_TURN);
      let buf = "", err = "", cost: number | null = null, failed: string | null = null, wrote = false;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let m: Record<string, unknown>;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") send({ type: "session", id: m.session_id });
          else if (m.type === "stream_event") {
            const ev = m.event as { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string } } | undefined;
            // (a new text block after tools: start it on a new paragraph)
            if (ev?.type === "content_block_start" && ev.content_block?.type === "text" && wrote) send({ type: "text", text: "\n\n" });
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) { send({ type: "text", text: ev.delta.text }); wrote = true; }
          } else if (m.type === "assistant") {
            const content = (m.message as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } | undefined)?.content ?? [];
            for (const b of content) if (b.type === "tool_use" && b.name) send({ type: "tool", name: b.name, detail: toolDetail(b.name, b.input ?? {}) });
          } else if (m.type === "result") {
            cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : null;
            if (m.is_error) failed = typeof m.result === "string" && m.result ? m.result : `The assistant stopped (${String(m.subtype ?? "error")}).`;
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { err = (err + chunk).slice(-2000); });

      const finish = async (code: number | null, spawnError?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        if (spawnError) failed = `Couldn't start Claude Code (${spawnError.message}). Is the claude CLI installed and signed in for the server's user?`;
        else if (signal.aborted) failed = "Stopped.";
        else if (code !== 0 && !failed) failed = err.trim() || `Claude Code ended with code ${code}.`;
        try { send({ type: "plan", network: JSON.parse(await readFile(next, "utf8")) }); } catch { /* no change to the plan */ }
        try { const steps = await readWalkthrough(dir); if (steps.length) send({ type: "steps", steps }); } catch { /* no walkthrough */ }
        send({ type: "done", cost, error: failed });
        close();
        // (the folder is only for this message: the conversation keeps what it needs)
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      };
      let ended = false;
      child.on("error", e => { if (!ended) { ended = true; void finish(null, e); } });
      child.on("close", code => { if (!ended) { ended = true; void finish(code); } });
    },
  });
}
