import type { NextRequest } from "next/server";
import { bodyOf, revoke, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The user lets an agent go: { pageId (the hub), agentId }. Its tabs stay open, marked as left.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  return Response.json({ ok: revoke(r.p, str(body.agentId) ?? "") });
}
