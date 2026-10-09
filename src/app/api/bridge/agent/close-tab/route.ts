import type { NextRequest } from "next/server";
import { agentOf, bodyOf, closeTab, str } from "@/server/bridge";

// The agent closes one of its own tabs: { pageId }.
export async function POST(req: NextRequest) {
  const a = agentOf(req.headers.get("authorization"));
  if (!a) return Response.json({ error: "Not paired" }, { status: 401 });
  const ok = closeTab(a, str((await bodyOf(req)).pageId) ?? "");
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
