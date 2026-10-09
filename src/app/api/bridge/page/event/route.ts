import type { NextRequest } from "next/server";
import { addEvent, rec, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The user speaks to the agent from the page: { pageId, kind: "annotation" | "message", ... }; or the UI state the agent
// watches changed: { pageId, kind: "ui", changed } (see docs/claude-bridge.md).
const MAX = 4_000_000;

export async function POST(req: NextRequest) {
  const text = await req.text();
  if (text.length > MAX) return Response.json({ error: "Too large" }, { status: 413 });
  let raw: unknown = null;
  try { raw = JSON.parse(text); } catch { return Response.json({ error: "Bad request" }, { status: 400 }); }
  const { pageId, kind, ...rest } = rec(raw);
  if (kind !== "annotation" && kind !== "message" && kind !== "ui") return Response.json({ error: "Unknown kind" }, { status: 400 });
  const r = await pageFromRequest(req, { pageId: str(pageId) });
  if ("error" in r) return r.error;
  // (to the agents working on that page: a tab's own, or the hub's)
  const to = addEvent(r.p, { ...rest, kind });
  return Response.json({ ok: true, to });
}
