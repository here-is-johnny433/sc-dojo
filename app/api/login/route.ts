import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  createSessionToken,
  sessionCookieName,
  sessionCookieOptions,
  loginRateLimited,
  recordLoginFailure,
  clearLoginFailures,
} from "@/lib/auth";

// Compared against when the email doesn't exist, so an unknown email costs the
// same time as a wrong password (hash of "dummy", never a valid login).
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.7BWvsvJ0uJmU7uHnqfHfDNYQlHBBbnO";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (loginRateLimited(ip, email)) {
    return NextResponse.json({ error: "Demasiados intentos. Espera 15 minutos." }, { status: 429 });
  }

  const r = await db().query(
    "SELECT id, role, password_hash FROM users WHERE LOWER(email) = LOWER($1) AND active",
    [email]
  );
  const user = r.rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

  if (!user || !ok) {
    recordLoginFailure(ip, email);
    return NextResponse.json({ error: "Credenciales incorrectas" }, { status: 401 });
  }

  clearLoginFailures(ip, email);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    sessionCookieName(),
    await createSessionToken(Number(user.id), user.role),
    sessionCookieOptions()
  );
  return res;
}
