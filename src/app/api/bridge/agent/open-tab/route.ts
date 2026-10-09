import type { NextRequest } from "next/server";
import { agentOf, appPath, bodyOf, openTab, str } from "@/server/bridge";

// The agent asks for a tab of its own in the user's browser: { url (this app's page: a path, or a URL of this site; not its
// API), label?, task? } → { ok, pageId } once it has opened, or { pending } if the user hasn't let it open yet (25 s).
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export async function POST(req: NextRequest) {
  const a = agentOf(req.headers.get("authorization"));
  if (!a) return Response.json({ error: "Not paired" }, { status: 401 });
  const body = await bodyOf(req), raw = str(body.url) ?? "/";
  let u: URL;
  try { u = new URL(raw, req.nextUrl.origin); } catch { return Response.json({ ok: false, error: "Not a URL" }, { status: 400 }); }
  if (u.origin !== req.nextUrl.origin) return Response.json({ ok: false, error: "Only pages of this app" }, { status: 400 });
  const path = appPath((BASE && u.pathname.startsWith(BASE) ? u.pathname.slice(BASE.length) || "/" : u.pathname) + u.search);
  if (!path) return Response.json({ ok: false, error: "Only pages of this app, not its API" }, { status: 400 });
  const r = await openTab(a, path, (str(body.label) ?? "").slice(0, 80), (str(body.task) ?? "").slice(0, 40), 25_000);
  return Response.json(r, { status: r.ok || r.pending ? 200 : 409, headers: { "Cache-Control": "no-store" } });
}
