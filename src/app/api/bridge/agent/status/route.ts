import type { NextRequest } from "next/server";
import { agentOf, status } from "@/server/bridge";

// Where the agent's page is, and whether it is connected now.
export async function GET(req: NextRequest) {
  const p = agentOf(req.headers.get("authorization"));
  if (!p) return Response.json({ error: "Not paired" }, { status: 401 });
  return Response.json(status(p), { headers: { "Cache-Control": "no-store" } });
}
