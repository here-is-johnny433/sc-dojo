import { db } from "./db";

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

export async function recentGames(limit = 50, offset = 0): Promise<GameRow[]> {
  const r = await db().query(
    `SELECT * FROM v_my_games ORDER BY played_at DESC NULLS LAST LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return r.rows;
}

export async function overviewStats() {
  const r = await db().query(`
    SELECT COUNT(*)::int AS games,
           COUNT(*) FILTER (WHERE i_won)::int AS wins,
           COUNT(*) FILTER (WHERE i_won IS NOT NULL)::int AS decided,
           ROUND(AVG(apm))::int AS avg_apm,
           ROUND(AVG(eapm))::int AS avg_eapm,
           ROUND(AVG(hotkey_pct)::numeric, 1)::float AS avg_hotkey_pct
    FROM v_my_games WHERE NOT is_practice`);
  return r.rows[0];
}

export async function matchupStats() {
  const r = await db().query(
    `SELECT * FROM v_matchup_stats ORDER BY games DESC`
  );
  return r.rows;
}

export async function mapStats() {
  const r = await db().query(`SELECT * FROM v_map_stats ORDER BY games DESC LIMIT 8`);
  return r.rows;
}

export async function monthlyTrend() {
  const r = await db().query(`SELECT * FROM v_monthly_trend`);
  return r.rows;
}

export async function activeGoal() {
  const r = await db().query(`
    SELECT g.*,
      (SELECT COUNT(*)::int FROM goal_checks c WHERE c.goal_id = g.id) AS checks,
      (SELECT COUNT(*)::int FROM goal_checks c WHERE c.goal_id = g.id AND c.passed) AS passed_checks,
      (SELECT COALESCE(json_agg(json_build_object('game_id', c.game_id, 'measured', c.measured_value, 'passed', c.passed) ORDER BY c.id DESC), '[]'::json)
         FROM (SELECT * FROM goal_checks WHERE goal_id = g.id ORDER BY id DESC LIMIT 10) c) AS recent_checks
    FROM training_goals g WHERE g.status = 'active' LIMIT 1`);
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

export async function gameDetail(id: string) {
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
  const observations = await db().query(
    `SELECT severity, text FROM game_observations WHERE game_id = $1 ORDER BY id`,
    [id]
  );
  return {
    game: game.rows[0],
    players: players.rows,
    events: events.rows,
    observations: observations.rows,
  };
}
