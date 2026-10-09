import type { NextRequest } from "next/server";
import { bodyOf, result, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The page's answer to one of the agent's commands: { pageId, id, ok, data?, error? }.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req), id = str(body.id);
  if (!id) return Response.json({ error: "Bad request" }, { status: 400 });
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  const err = str(body.error);
  const known = result(r.p, id, { ok: body.ok === true, data: body.data, error: err ? err.slice(0, 2000) : undefined });
  return Response.json({ ok: known });
}
