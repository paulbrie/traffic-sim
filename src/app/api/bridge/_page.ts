import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { pageOf } from "@/server/bridge";

/** the signed-in admin's page pairing a request is for (`pageId` and `x-bridge-page` / `t`), or the reason it isn't */
export async function pageFromRequest(req: NextRequest, body?: { pageId?: string }) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return { error: Response.json({ error: "Sign in first" }, { status: 401 }) } as const;
  if (me.role !== "admin") return { error: Response.json({ error: "Admins only" }, { status: 403 }) } as const;
  const pageId = body?.pageId ?? req.nextUrl.searchParams.get("pageId");
  const t = req.headers.get("x-bridge-page") ?? req.nextUrl.searchParams.get("t");
  const p = pageOf(pageId, t, me.id);
  if (!p) return { error: Response.json({ error: "Not paired" }, { status: 404 }) } as const;
  return { p } as const;
}
