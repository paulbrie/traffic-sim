import type { NextRequest } from "next/server";
import { agentOf, bodyOf, command, editPermit, rec, str, targetOf } from "@/server/bridge";
import { isEditAction } from "@/lib/bridge-edits";

// The agent's command to one of its pages: { type, args, pageId? } → the page's result, waited for (30 s at most). Without
// pageId: the tab it opened last, or the hub if it drives it.
const TYPES = new Set(["snapshot", "screenshot", "state", "click", "type", "key", "navigate", "app"]);

export async function POST(req: NextRequest) {
  const a = agentOf(req.headers.get("authorization"));
  if (!a) return Response.json({ error: "Not paired" }, { status: 401 });
  const body = await bodyOf(req), type = str(body.type);
  if (!type || !TYPES.has(type)) return Response.json({ error: `Unknown command (one of: ${[...TYPES].join(", ")})` }, { status: 400 });
  const p = targetOf(a, str(body.pageId));
  if ("error" in p) return Response.json({ ok: false, error: p.error }, { status: 409 });
  if (!p.streams.size && !p.tab?.paused && !p.tab?.left) return Response.json({ ok: false, error: "That page isn't connected" }, { status: 409 });
  // (agent edits, T189: refused here unless the user allows them in the hub's panel; the page is told the leave it has, set
  // here and nowhere else, and checks the editor and sketch against it)
  const { permit: _ignored, ...args } = rec(body.args);
  if (type === "app" && typeof args.action === "string" && isEditAction(args.action)) {
    const permit = editPermit(p);
    if (permit.mode === "off") return Response.json({ ok: false, error: "Agent edits are off: the user can allow them in the Claude panel (Allow agent edits)", pageId: p.pageId }, { status: 403 });
    args.permit = permit;
  }
  const r = await command(p, type, args);
  return Response.json({ ...r, pageId: p.pageId }, { status: r.ok ? 200 : r.error?.includes("in time") ? 504 : 200 });
}
