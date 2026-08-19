import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relinkAlias, unlinkAlias } from "@/lib/relink";
import { requireAdminApi } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function userExists(id: number): Promise<boolean> {
  const r = await db().query("SELECT 1 FROM users WHERE id = $1", [id]);
  return !!r.rowCount;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;

  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (!Number.isInteger(id) || !alias) {
    return NextResponse.json({ error: "Falta el alias" }, { status: 400 });
  }
  if (!(await userExists(id))) {
    return NextResponse.json({ error: "jugador no encontrado" }, { status: 404 });
  }

  // Un alias pertenece a un solo jugador (índice único sobre LOWER(alias)).
  const taken = await db().query("SELECT 1 FROM player_aliases WHERE LOWER(alias) = LOWER($1)", [
    alias,
  ]);
  if (taken.rowCount) {
    return NextResponse.json({ error: "Ese alias ya pertenece a otro jugador" }, { status: 409 });
  }

  await db().query("INSERT INTO player_aliases (user_id, alias) VALUES ($1,$2)", [id, alias]);
  const { linkedGames } = await relinkAlias(id, alias);
  return NextResponse.json({ ok: true, linkedGames });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;

  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (!Number.isInteger(id) || !alias) {
    return NextResponse.json({ error: "Falta el alias" }, { status: 400 });
  }

  const r = await db().query(
    "DELETE FROM player_aliases WHERE user_id = $1 AND LOWER(alias) = LOWER($2)",
    [id, alias]
  );
  if (!r.rowCount) return NextResponse.json({ error: "alias no encontrado" }, { status: 404 });
  await unlinkAlias(id, alias);
  return NextResponse.json({ ok: true });
}
