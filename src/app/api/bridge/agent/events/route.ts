import type { NextRequest } from "next/server";
import { agentOf, events } from "@/server/bridge";

// The user's annotations and messages from the agent's pages after `after`, waited for up to `wait` seconds (25 at most).
export async function GET(req: NextRequest) {
  const a = agentOf(req.headers.get("authorization"));
  if (!a) return Response.json({ error: "Not paired" }, { status: 401 });
  const after = Number(req.nextUrl.searchParams.get("after") ?? 0) || 0, wait = Math.min(25, Math.max(0, Number(req.nextUrl.searchParams.get("wait") ?? 0) || 0));
  return Response.json(await events(a, after, wait * 1000, req.signal), { headers: { "Cache-Control": "no-store" } });
}
