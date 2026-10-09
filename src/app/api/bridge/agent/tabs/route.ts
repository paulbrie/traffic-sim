import type { NextRequest } from "next/server";
import { agentOf, tabsFor } from "@/server/bridge";

// The agent's own tabs: { tabs: [{ pageId, url, title, label, task, connected, paused, left }] }.
export async function GET(req: NextRequest) {
  const a = agentOf(req.headers.get("authorization"));
  if (!a) return Response.json({ error: "Not paired" }, { status: 401 });
  return Response.json({ tabs: tabsFor(a) }, { headers: { "Cache-Control": "no-store" } });
}
