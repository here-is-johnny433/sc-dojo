import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { listUsers } from "@/lib/admin";
import { requireAdminApi } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ users: await listUsers() });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;

  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const role = body.role === "admin" ? "admin" : "player";
  const password = typeof body.password === "string" ? body.password : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Correo inválido" }, { status: 400 });
  }
  if (!name) return NextResponse.json({ error: "Falta el nombre" }, { status: 400 });
  if (password.length < 8) {
    return NextResponse.json({ error: "La contraseña necesita 8 caracteres" }, { status: 400 });
  }

  const dup = await db().query("SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)", [email]);
  if (dup.rowCount) {
    return NextResponse.json({ error: "Ya existe un jugador con ese correo" }, { status: 409 });
  }

  const r = await db().query(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [email, name, role, bcrypt.hashSync(password, 12)]
  );
  return NextResponse.json({ id: Number(r.rows[0].id) }, { status: 201 });
}
