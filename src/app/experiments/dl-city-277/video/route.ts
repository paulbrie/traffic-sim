import type { NextRequest } from "next/server";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { getCurrentUser } from "@/server/auth";
import { VIDEO_FILE, sizeOf } from "../files";

// The experiment's explainer video (ticket #277), to anyone signed in. Answers byte ranges, so the player can seek
// (and Safari, which asks for a range first, can play it at all).
export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return new Response("Sign in first", { status: 401 });
  const size = await sizeOf(VIDEO_FILE);
  if (size === null) return new Response("The video hasn't been made here (scripts/dl-city-video.ts).", { status: 404 });
  const headers = { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" };
  const body = (start: number, end: number) => Readable.toWeb(createReadStream(VIDEO_FILE, { start, end })) as ReadableStream;

  const range = req.headers.get("range");
  if (!range) return new Response(body(0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
  // (one range: "bytes=a-b", "bytes=a-" or the last n, "bytes=-n")
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = m && m[1] ? Number(m[1]) : NaN, end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  end = Math.min(end, size - 1);
  if (!m || !Number.isFinite(start) || start > end || start >= size) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  return new Response(body(start, end), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
  });
}
