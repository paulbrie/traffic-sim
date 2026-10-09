import type { NextRequest } from "next/server";
import { agentOf, bodyOf, command, rec, str, targetOf } from "@/server/bridge";

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
  const r = await command(p, type, rec(body.args));
  return Response.json({ ...r, pageId: p.pageId }, { status: r.ok ? 200 : r.error?.includes("in time") ? 504 : 200 });
}
