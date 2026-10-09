import type { NextRequest } from "next/server";
import { bodyOf, claim, str } from "@/server/bridge";

// An agent claims a page by the code shown in it: { code, agent } → { agentToken, pageId }.
export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  const code = (str(body.code) ?? "").replace(/\D/g, "");
  if (code.length !== 6) return Response.json({ error: "A 6-digit code, please" }, { status: 400 });
  const r = claim(code, str(body.agent) ?? "Claude");
  if (!r) return Response.json({ error: "No page with that code (it lasts 10 minutes)" }, { status: 404 });
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
}
