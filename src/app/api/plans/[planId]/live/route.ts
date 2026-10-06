import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser } from "@/server/auth";
import { allows, planAccess } from "@/server/access";

// Live updates of an open plan (Server-Sent Events): the plan's revision now, and again each time it
// changes (a save from another person, tab or window, or a change written to the database directly).
// The page then loads the new version and merges it with its own unsaved changes. `?once=1` answers
// with the revision as JSON instead (for browsers or proxies where the stream doesn't come through).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** how often the revision is looked at (ms), how often an idle stream says it is still there, and how long one stream lasts (the browser reconnects) */
const POLL = 1000, PING = 15_000, LIFETIME = 10 * 60_000;

async function revisionOf(planId: string): Promise<number | null> {
  const [row] = await db.select({ revision: schema.plans.revision }).from(schema.plans).where(eq(schema.plans.id, planId));
  return row ? row.revision : null;
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/plans/[planId]/live">) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return Response.json({ error: "Sign in first" }, { status: 401 });
  const { planId } = await ctx.params;
  if (!UUID.test(planId) || !allows((await planAccess(me, planId))?.access, "read")) return new Response("Not found", { status: 404 });
  if (req.nextUrl.searchParams.get("once")) return Response.json({ revision: await revisionOf(planId) }, { headers: { "Cache-Control": "no-store" } });

  const enc = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | null = null, closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const started = Date.now();
      let last = -1, lastSent = 0;
      const send = (text: string) => { if (!closed) { controller.enqueue(enc.encode(text)); lastSent = Date.now(); } };
      const stop = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); try { controller.close(); } catch { /* already closed */ } };
      req.signal.addEventListener("abort", stop);
      const tick = async () => {
        if (closed) return;
        try {
          const rev = await revisionOf(planId);
          if (rev === null) { send(`event: gone\ndata: {}\n\n`); stop(); return; }
          if (rev !== last) { last = rev; send(`event: revision\ndata: ${JSON.stringify({ revision: rev })}\n\n`); }
          else if (Date.now() - lastSent > PING) send(`: ping\n\n`);
        } catch { /* the database blinked: try again next time */ }
        if (Date.now() - started > LIFETIME) { stop(); return; }
        timer = setTimeout(tick, POLL);
      };
      // (a long retry hint is not wanted: reconnect quickly)
      send(`retry: 2000\n\n`);
      tick();
    },
    cancel() { closed = true; if (timer) clearTimeout(timer); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // (proxies such as nginx: pass it through as it comes)
      "X-Accel-Buffering": "no",
    },
  });
}
