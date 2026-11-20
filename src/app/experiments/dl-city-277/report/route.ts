import type { NextRequest } from "next/server";
import { readFile } from "fs/promises";
import { basePath } from "@/lib/base-path";
import { getCurrentUser } from "@/server/auth";
import { REPORT_FILE, sizeOf } from "../files";

// The experiment's report (ticket #277): one self-contained HTML file, served as it is to anyone signed in;
// with ?download, as a file to save (the report's own "Download this report" link, and the experiment page's).
export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  // (a relative Location with basePath: in a route handler neither redirect() nor the request's URL keeps basePath, and
  // the request's host is the dev server's own, not the public one)
  if (!me || me.mustChangePassword) return new Response(null, { status: 307, headers: { Location: `${basePath}/login?next=${encodeURIComponent("/experiments/dl-city-277/report")}` } });
  if ((await sizeOf(REPORT_FILE)) === null) return new Response("The report hasn't been built here (npm run dl-city:html).", { status: 404 });
  const download = req.nextUrl.searchParams.has("download");
  return new Response(await readFile(REPORT_FILE), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
      ...(download ? { "Content-Disposition": 'attachment; filename="dl-city-277-report.html"' } : {}),
    },
  });
}
