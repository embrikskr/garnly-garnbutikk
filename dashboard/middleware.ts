import { NextRequest, NextResponse } from "next/server";

/**
 * Enkel passordbeskyttelse (HTTP Basic) for hele dashboardet.
 * DASHBOARD_PASSWORD tomt/usatt = åpent, kun ment for lokal utvikling.
 */
export function middleware(req: NextRequest) {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return NextResponse.next();
  const header = req.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    try {
      const decoded = atob(encoded);
      const pwd = decoded.slice(decoded.indexOf(":") + 1);
      if (pwd === pass) return NextResponse.next();
    } catch {
      // ugyldig base64 → fall gjennom til 401
    }
  }
  return new NextResponse("Autentisering kreves", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Garnly dashboard"' },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
