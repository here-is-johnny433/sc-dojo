// Server-only session helpers. Imports pg, so it must never be imported from
// middleware.ts (edge runtime) — token verification lives in lib/auth.ts.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { db } from "./db";
import { sessionCookieName, verifySessionToken, type Role } from "./auth";

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  aliases: string[];
}

/** Cookie → payload → live user row. Deactivated users lose access at once. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const r = await db().query(
    `SELECT u.id, u.email, u.name, u.role,
            COALESCE(ARRAY_AGG(a.alias ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL), '{}') AS aliases
     FROM users u LEFT JOIN player_aliases a ON a.user_id = u.id
     WHERE u.id = $1 AND u.active
     GROUP BY u.id`,
    [payload.userId]
  );
  if (!r.rowCount) return null;
  const u = r.rows[0];
  return { id: Number(u.id), email: u.email, name: u.name, role: u.role, aliases: u.aliases };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}

/**
 * Admin guard for route handlers: returns the response to send back instead of
 * redirecting (an API answers with JSON). Use as
 * `const admin = await requireAdminApi(); if (admin instanceof NextResponse) return admin;`
 */
export async function requireAdminApi(): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return user;
}
