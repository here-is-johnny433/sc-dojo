import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, validUploadToken, sessionCookieName } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/login"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();

  const session = await verifySessionToken(req.cookies.get(sessionCookieName())?.value);

  // Watchers authenticate uploads with a token header instead of a cookie.
  if (pathname === "/api/upload") {
    if (session || validUploadToken(req.headers.get("x-upload-token"))) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (session) {
    // Admin area: the role travels in the signed token, so no DB hit here.
    // Handlers re-check with requireAdmin() against the live row.
    if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
      if (session.role !== "admin") {
        if (pathname.startsWith("/api/")) {
          return NextResponse.json({ error: "forbidden" }, { status: 403 });
        }
        const home = req.nextUrl.clone();
        home.pathname = "/";
        home.search = "";
        return NextResponse.redirect(home);
      }
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next.js internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
