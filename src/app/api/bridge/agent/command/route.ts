import type { NextRequest } from "next/server";
import { agentOf, bodyOf, command, rec, status, str } from "@/server/bridge";

// The agent's command to its page: { type, args } → the page's result, waited for (30 s at most).
const TYPES = new Set(["snapshot", "screenshot", "state", "click", "type", "key", "navigate", "app"]);

export async function POST(req: NextRequest) {
  const p = agentOf(req.headers.get("authorization"));
  if (!p) return Response.json({ error: "Not paired" }, { status: 401 });
  const body = await bodyOf(req), type = str(body.type);
  if (!type || !TYPES.has(type)) return Response.json({ error: `Unknown command (one of: ${[...TYPES].join(", ")})` }, { status: 400 });
  if (!status(p).page?.connected) return Response.json({ ok: false, error: "No page connected" }, { status: 409 });
  const r = await command(p, type, rec(body.args));
  return Response.json(r, { status: r.ok ? 200 : r.error?.includes("in time") ? 504 : 200 });
}
