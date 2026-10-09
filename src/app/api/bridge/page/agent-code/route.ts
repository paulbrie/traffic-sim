import type { NextRequest } from "next/server";
import { agentCode, bodyOf, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// A code for another agent to attach to the hub (it works in tabs of its own): { pageId } → { code, expiresAt }.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  const c = agentCode(r.p);
  return c ? Response.json(c, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Only the hub" }, { status: 400 });
}
