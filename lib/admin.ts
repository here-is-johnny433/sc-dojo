// Datos del módulo admin, compartidos entre la página server y su API.

import { db } from "./db";
import type { Role } from "./auth";

export interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  created_at: string;
  aliases: string[];
  games: number;
}

export async function listUsers(): Promise<AdminUser[]> {
  const r = await db().query(
    `SELECT u.id, u.email, u.name, u.role, u.active, u.created_at,
            COALESCE(ARRAY_AGG(a.alias ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL), '{}') AS aliases,
            (SELECT COUNT(DISTINCT gp.game_id)::int FROM game_players gp WHERE gp.user_id = u.id) AS games
     FROM users u LEFT JOIN player_aliases a ON a.user_id = u.id
     GROUP BY u.id ORDER BY u.created_at`
  );
  return r.rows.map((u) => ({ ...u, id: Number(u.id) }));
}
