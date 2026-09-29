import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: sends visitors without a session cookie to the sign-in page.
// Pages, server actions and route handlers verify the session against the database themselves.
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === "/login" || pathname === "/signup") return NextResponse.next();
  if (req.cookies.get("gl_session")?.value) return NextResponse.next();
  // clone nextUrl (not new URL(req.url)) so the redirect keeps basePath; pathname here excludes it
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  // every page except Next internals, API routes (they answer 401 themselves) and static files
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt)$).*)"],
};
