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

// ---------- Espectro de rendimiento (player_scores) ----------

export interface ScoreHistoryRow {
  game_id: string;
  played_at: string | null;
  map_name: string | null;
  matchup: string | null;
  my_matchup: string | null;
  duration_seconds: number | null;
  is_winner: boolean | null;
  race: string | null;
  mechanics: number | null;
  economy: number | null;
  macro: number | null;
  combat: number | null;
  build: number | null;
  overall: number | null;
  with_resim: boolean;
}

/** Score evolution of one player (by name), oldest first. */
export async function playerScoreHistory(name: string, limit = 200): Promise<ScoreHistoryRow[]> {
  const r = await db().query(
    `SELECT s.game_id, g.played_at, g.map_name, g.matchup, g.my_matchup, g.duration_seconds,
            p.is_winner, p.race,
            s.mechanics, s.economy, s.macro, s.combat, s.build, s.overall, s.with_resim
     FROM player_scores s
     JOIN game_players p ON p.game_id = s.game_id AND p.player_id = s.player_id
     JOIN games g ON g.id = s.game_id
     WHERE lower(p.name) = lower($1)
     ORDER BY g.played_at ASC NULLS LAST
     LIMIT $2`,
    [name, limit]
  );
  return r.rows;
}

/** All player names seen across games, with how often — for the profile index. */
export async function knownPlayers() {
  const r = await db().query(
    `SELECT p.name,
            COUNT(*)::int AS games,
            BOOL_OR(p.is_me) AS is_me,
            MAX(g.played_at) AS last_played
     FROM game_players p JOIN games g ON g.id = p.game_id
     WHERE NOT p.is_computer
     GROUP BY p.name ORDER BY games DESC, last_played DESC`
  );
  return r.rows;
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
