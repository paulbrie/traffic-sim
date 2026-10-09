import type { NextRequest } from "next/server";
import { bodyOf, hello, str } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// Where the page is now (on connecting and on every navigation): { pageId, url, title }.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  hello(r.p, { url: str(body.url) ?? "", title: str(body.title) ?? "" });
  return Response.json({ ok: true });
}
