import type { NextRequest } from "next/server";
import { bodyOf, close, str, tabOfHub } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The hub closes one of its agents' tabs: { pageId (the hub), tabId }. The tab is told (and closes if it can).
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  const tab = tabOfHub(r.p, str(body.tabId) ?? "");
  if (tab) close(tab);
  return Response.json({ ok: !!tab });
}
