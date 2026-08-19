import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  createSessionToken,
  sessionCookieName,
  sessionCookieOptions,
  loginRateLimited,
  recordLoginFailure,
  clearLoginFailures,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (loginRateLimited(ip)) {
    return NextResponse.json({ error: "Demasiados intentos. Espera 15 minutos." }, { status: 429 });
  }

  const { password } = await req.json().catch(() => ({ password: "" }));
  const hash = process.env.AUTH_PASSWORD_HASH;
  if (!hash) return NextResponse.json({ error: "AUTH_PASSWORD_HASH no configurado" }, { status: 500 });

  if (typeof password !== "string" || !(await bcrypt.compare(password, hash))) {
    recordLoginFailure(ip);
    return NextResponse.json({ error: "Contraseña incorrecta" }, { status: 401 });
  }

  clearLoginFailures(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookieName(), await createSessionToken(), sessionCookieOptions());
  return res;
}
