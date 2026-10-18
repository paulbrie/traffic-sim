import type { NextRequest } from "next/server";
import { allowEdits, bodyOf, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The hub lets its agents edit, or not (T189): { pageId, permit: { mode: "off" | "all" } | { mode: "sketch", plan, sketch, name } }.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  if (r.p.kind !== "hub") return Response.json({ error: "Only the hub" }, { status: 400 });
  allowEdits(r.p, body.permit);
  return Response.json({ ok: true });
}
