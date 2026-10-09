import type { NextRequest } from "next/server";
import { bodyOf, pauseTab, str, tabOfHub } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The user takes over an agent's tab (its commands refused, "paused by user") or gives it back: { pageId (the tab, or the
// hub with tabId), paused }.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const r = await pageFromRequest(req, { pageId: str(body.pageId) });
  if ("error" in r) return r.error;
  const tab = r.p.kind === "hub" ? tabOfHub(r.p, str(body.tabId) ?? "") : r.p;
  return Response.json({ ok: !!tab && pauseTab(tab, body.paused === true) });
}
