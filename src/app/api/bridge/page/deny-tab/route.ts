import type { NextRequest } from "next/server";
import { bodyOf, denyTab, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The user won't open a tab an agent asked for: { pageId (the hub), ticket }.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  return Response.json({ ok: denyTab(r.p, str(body.ticket) ?? "") });
}
