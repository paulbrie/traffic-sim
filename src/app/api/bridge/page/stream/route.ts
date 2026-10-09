import type { NextRequest } from "next/server";
import { subscribe } from "@/server/bridge";
import { pageFromRequest } from "../../_page";

// The page's stream (Server-Sent Events): who is attached (`agent`), the agent's commands (`command`), the pairing's
// end (`closed`), and a `ping` now and then. A stream lasts LIFETIME at most; the browser then reconnects.
const PING = 15_000, LIFETIME = 10 * 60_000;

export async function GET(req: NextRequest) {
  const r = await pageFromRequest(req);
  if ("error" in r) return r.error;
  const enc = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => { if (!closed) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };
      const unsub = subscribe(r.p, m => { send(m.event, m.data); if (m.event === "closed") stop(); });
      const ping = setInterval(() => send("ping", Date.now()), PING), end = setTimeout(() => stop(), LIFETIME);
      stop = () => { if (closed) return; closed = true; unsub(); clearInterval(ping); clearTimeout(end); try { controller.close(); } catch { /* already closed */ } };
      req.signal.addEventListener("abort", () => stop());
    },
    cancel() { stop(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
