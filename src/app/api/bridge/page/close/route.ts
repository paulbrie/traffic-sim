import type { NextRequest } from "next/server";
import { bodyOf, close, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The user disconnects the agent: the pairing ends.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  close(r.p);
  return Response.json({ ok: true });
}
