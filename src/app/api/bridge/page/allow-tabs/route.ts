import type { NextRequest } from "next/server";
import { allowTabs, bodyOf, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The hub lets its agents open tabs, or not: { pageId, on }.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  if (r.p.kind !== "hub") return Response.json({ error: "Only the hub" }, { status: 400 });
  allowTabs(r.p, body.on === true);
  return Response.json({ ok: true });
}
