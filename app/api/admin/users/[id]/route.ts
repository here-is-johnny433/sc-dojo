import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sin borrado duro: los FK harían cascade sobre metas, notas y chats. Se
// desactiva, que además invalida la sesión del usuario en el acto.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const sets: string[] = [];
  const params: unknown[] = [id];

  if (typeof body.name === "string" && body.name.trim()) {
    params.push(body.name.trim());
    sets.push(`name = $${params.length}`);
  }
  if (body.role === "admin" || body.role === "player") {
    if (id === admin.id && body.role !== "admin") {
      return NextResponse.json({ error: "No puedes quitarte el rol de admin" }, { status: 400 });
    }
    params.push(body.role);
    sets.push(`role = $${params.length}`);
  }
  if (typeof body.active === "boolean") {
    if (id === admin.id && !body.active) {
      return NextResponse.json({ error: "No puedes desactivarte a ti mismo" }, { status: 400 });
    }
    params.push(body.active);
    sets.push(`active = $${params.length}`);
  }
  if (typeof body.password === "string" && body.password) {
    if (body.password.length < 8) {
      return NextResponse.json({ error: "La contraseña necesita 8 caracteres" }, { status: 400 });
    }
    params.push(bcrypt.hashSync(body.password, 12));
    sets.push(`password_hash = $${params.length}`);
  }
  if (!sets.length) return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });

  const r = await db().query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING id`,
    params
  );
  if (!r.rowCount) return NextResponse.json({ error: "jugador no encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
