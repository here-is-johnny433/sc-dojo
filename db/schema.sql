-- Starcraft Dojo — schema
-- Applied automatically by the Postgres container entrypoint (docker) or `pnpm db:setup` (bare).

CREATE TABLE IF NOT EXISTS games (
  id                TEXT PRIMARY KEY,              -- sha256(file)[0:16], dedups across machines
  file_name         TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'upload',-- autosave-mac | autosave-win | upload
  played_at         TIMESTAMPTZ,
  frames            INTEGER,
  duration_seconds  INTEGER,
  map_name          TEXT,
  map_width         INTEGER,
  map_height        INTEGER,
  game_type         TEXT,
  matchup           TEXT,                          -- raw screp form, e.g. "TTvPZ"
  my_matchup        TEXT,                          -- from my perspective, e.g. "PZ vs TT"
  winner_team       INTEGER,
  my_team           INTEGER,
  my_name           TEXT,
  my_race           TEXT,
  i_won             BOOLEAN,                       -- null when screp couldn't detect a winner
  is_practice       BOOLEAN NOT NULL DEFAULT FALSE,-- true when any Computer player present
  title             TEXT,
  host              TEXT,
  rep_path          TEXT,
  json_path         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL,
  name        TEXT NOT NULL,
  race        TEXT,
  team        INTEGER,
  apm         INTEGER,
  eapm        INTEGER,
  cmd_count   INTEGER,
  hotkey_pct  REAL,
  is_me       BOOLEAN NOT NULL DEFAULT FALSE,
  is_winner   BOOLEAN,
  is_computer BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (game_id, player_id)
);

CREATE TABLE IF NOT EXISTS build_order_events (
  id          BIGSERIAL PRIMARY KEY,
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  frame       INTEGER NOT NULL,
  seconds     INTEGER NOT NULL,
  kind        TEXT NOT NULL,                       -- Train | Build | Unit Morph | Building Morph | Upgrade | Tech
  item        TEXT NOT NULL,
  supply_cost REAL
);
CREATE INDEX IF NOT EXISTS idx_boe_game ON build_order_events(game_id, player_id, frame);

CREATE TABLE IF NOT EXISTS game_observations (
  id       BIGSERIAL PRIMARY KEY,
  game_id  TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','good')),
  text     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notes (
  id         BIGSERIAL PRIMARY KEY,
  area       TEXT NOT NULL CHECK (area IN ('macro','micro','matchup','build_order','scouting','progress','general')),
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_goals (
  id              BIGSERIAL PRIMARY KEY,
  area            TEXT NOT NULL,
  title           TEXT NOT NULL,
  metric_key      TEXT NOT NULL,                   -- e.g. probes_at_6min, hotkey_pct, expansion_by, no_probe_gap_over
  target_value    REAL NOT NULL,
  comparator      TEXT NOT NULL DEFAULT '>=' CHECK (comparator IN ('>=','<=')),
  streak_required INTEGER NOT NULL DEFAULT 5,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','abandoned')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  achieved_at     TIMESTAMPTZ
);
-- Only one active goal at a time (deliberate practice: one focus).
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_goal ON training_goals(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS goal_checks (
  id             BIGSERIAL PRIMARY KEY,
  goal_id        BIGINT NOT NULL REFERENCES training_goals(id) ON DELETE CASCADE,
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  measured_value REAL,
  passed         BOOLEAN NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (goal_id, game_id)
);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id         BIGSERIAL PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'Nueva conversación',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         JSONB NOT NULL,                  -- Anthropic API content blocks
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msgs_conv ON chat_messages(conversation_id, id);

-- ---------- Views for Looker Studio ----------

CREATE OR REPLACE VIEW v_my_games AS
SELECT g.id, g.played_at, g.map_name, g.game_type, g.matchup, g.my_matchup,
       g.duration_seconds, g.my_race, g.i_won, g.is_practice, g.source,
       p.apm, p.eapm, p.hotkey_pct, p.name AS my_alias
FROM games g
JOIN game_players p ON p.game_id = g.id AND p.is_me;

CREATE OR REPLACE VIEW v_matchup_stats AS
SELECT my_matchup,
       COUNT(*)                                   AS games,
       COUNT(*) FILTER (WHERE i_won)              AS wins,
       ROUND(100.0 * COUNT(*) FILTER (WHERE i_won) / NULLIF(COUNT(*) FILTER (WHERE i_won IS NOT NULL), 0), 1) AS winrate_pct,
       ROUND(AVG(apm))                            AS avg_apm
FROM v_my_games
WHERE NOT is_practice
GROUP BY my_matchup;

CREATE OR REPLACE VIEW v_map_stats AS
SELECT map_name,
       COUNT(*)                                   AS games,
       COUNT(*) FILTER (WHERE i_won)              AS wins,
       ROUND(100.0 * COUNT(*) FILTER (WHERE i_won) / NULLIF(COUNT(*) FILTER (WHERE i_won IS NOT NULL), 0), 1) AS winrate_pct
FROM v_my_games
WHERE NOT is_practice
GROUP BY map_name;

CREATE OR REPLACE VIEW v_monthly_trend AS
SELECT date_trunc('month', played_at)::date       AS month,
       COUNT(*)                                   AS games,
       ROUND(100.0 * COUNT(*) FILTER (WHERE i_won) / NULLIF(COUNT(*) FILTER (WHERE i_won IS NOT NULL), 0), 1) AS winrate_pct,
       ROUND(AVG(apm))                            AS avg_apm,
       ROUND(AVG(eapm))                           AS avg_eapm
FROM v_my_games
WHERE NOT is_practice
GROUP BY 1 ORDER BY 1;
