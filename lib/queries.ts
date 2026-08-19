import { db } from "./db";
import type { SessionUser } from "./session";

export interface GameRow {
  id: string;
  played_at: string | null;
  map_name: string | null;
  game_type: string | null;
  my_matchup: string | null;
  matchup: string | null;
  duration_seconds: number | null;
  my_race: string | null;
  i_won: boolean | null;
  is_practice: boolean;
  source: string;
  apm: number | null;
  eapm: number | null;
  hotkey_pct: number | null;
  my_alias: string | null;
}

export async function recentGames(userId: number, limit = 50, offset = 0): Promise<GameRow[]> {
  const r = await db().query(
    `SELECT * FROM v_player_games WHERE user_id = $1
     ORDER BY played_at DESC NULLS LAST LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return r.rows;
}

export async function overviewStats(userId: number) {
  const r = await db().query(
    `SELECT COUNT(*)::int AS games,
            COUNT(*) FILTER (WHERE i_won)::int AS wins,
            COUNT(*) FILTER (WHERE i_won IS NOT NULL)::int AS decided,
            ROUND(AVG(apm))::int AS avg_apm,
            ROUND(AVG(eapm))::int AS avg_eapm,
            ROUND(AVG(hotkey_pct)::numeric, 1)::float AS avg_hotkey_pct
     FROM v_player_games WHERE user_id = $1 AND NOT is_practice`,
    [userId]
  );
  return r.rows[0];
}

export async function matchupStats(userId: number) {
  const r = await db().query(
    `SELECT my_matchup,
            COUNT(*)::int AS games,
            COUNT(*) FILTER (WHERE i_won)::int AS wins,
            ROUND(100.0 * COUNT(*) FILTER (WHERE i_won) / NULLIF(COUNT(*) FILTER (WHERE i_won IS NOT NULL), 0), 1) AS winrate_pct,
            ROUND(AVG(apm)) AS avg_apm
     FROM v_player_games WHERE user_id = $1 AND NOT is_practice
     GROUP BY my_matchup ORDER BY games DESC`,
    [userId]
  );
  return r.rows;
}

export async function mapStats(userId: number) {
  const r = await db().query(
    `SELECT map_name,
            COUNT(*)::int AS games,
            COUNT(*) FILTER (WHERE i_won)::int AS wins,
            ROUND(100.0 * COUNT(*) FILTER (WHERE i_won) / NULLIF(COUNT(*) FILTER (WHERE i_won IS NOT NULL), 0), 1) AS winrate_pct
     FROM v_player_games WHERE user_id = $1 AND NOT is_practice
     GROUP BY map_name ORDER BY games DESC LIMIT 8`,
    [userId]
  );
  return r.rows;
}

export async function monthlyTrend(userId: number) {
  const r = await db().query(
    `SELECT date_trunc('month', played_at)::date AS month,
            COUNT(*)::int AS games,
            ROUND(100.0 * COUNT(*) FILTER (WHERE i_won) / NULLIF(COUNT(*) FILTER (WHERE i_won IS NOT NULL), 0), 1) AS winrate_pct,
            ROUND(AVG(apm)) AS avg_apm,
            ROUND(AVG(eapm)) AS avg_eapm
     FROM v_player_games WHERE user_id = $1 AND NOT is_practice
     GROUP BY 1 ORDER BY 1`,
    [userId]
  );
  return r.rows;
}

export async function activeGoal(userId: number) {
  const r = await db().query(
    `SELECT g.*,
      (SELECT COUNT(*)::int FROM goal_checks c WHERE c.goal_id = g.id) AS checks,
      (SELECT COUNT(*)::int FROM goal_checks c WHERE c.goal_id = g.id AND c.passed) AS passed_checks,
      (SELECT COALESCE(json_agg(json_build_object('game_id', c.game_id, 'measured', c.measured_value, 'passed', c.passed) ORDER BY c.id DESC), '[]'::json)
         FROM (SELECT * FROM goal_checks WHERE goal_id = g.id ORDER BY id DESC LIMIT 10) c) AS recent_checks
    FROM training_goals g WHERE g.status = 'active' AND g.user_id = $1 LIMIT 1`,
    [userId]
  );
  return r.rows[0] ?? null;
}

// Current streak of consecutive passing checks (most recent first).
export function goalStreak(recentChecks: { passed: boolean }[]): number {
  let streak = 0;
  for (const c of recentChecks) {
    if (c.passed) streak++;
    else break;
  }
  return streak;
}

/** Jugadores activos, para el selector de perspectiva del dashboard. */
export async function listPlayers(): Promise<{ id: number; name: string; role: string }[]> {
  const r = await db().query("SELECT id, name, role FROM users WHERE active ORDER BY name");
  return r.rows.map((u) => ({ id: Number(u.id), name: u.name, role: u.role }));
}

export async function gameDetail(id: string, viewer: SessionUser) {
  const game = await db().query(`SELECT * FROM games WHERE id = $1`, [id]);
  if (!game.rowCount) return null;
  const players = await db().query(
    `SELECT * FROM game_players WHERE game_id = $1 ORDER BY team, player_id`,
    [id]
  );
  const events = await db().query(
    `SELECT player_id, player_name, frame, seconds, kind, item, supply_cost
     FROM build_order_events WHERE game_id = $1 ORDER BY frame`,
    [id]
  );
  // Las observaciones son privadas: solo su dueño (o un admin) las ve.
  const observations = await db().query(
    `SELECT severity, text FROM game_observations
     WHERE game_id = $1 AND ($2::boolean OR user_id = $3) ORDER BY id`,
    [id, viewer.role === "admin", viewer.id]
  );
  return {
    game: game.rows[0],
    players: players.rows,
    events: events.rows,
    observations: observations.rows,
  };
}
