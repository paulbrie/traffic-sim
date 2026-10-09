import type { NextRequest } from "next/server";
import { agentOf, status } from "@/server/bridge";

// What the agent sees: who it is, the hub's page (if it drives it), whether tabs are allowed, and its tabs.
export async function GET(req: NextRequest) {
  const a = agentOf(req.headers.get("authorization"));
  if (!a) return Response.json({ error: "Not paired" }, { status: 401 });
  return Response.json(status(a), { headers: { "Cache-Control": "no-store" } });
}
