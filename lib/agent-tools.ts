import fs from "fs/promises";
import zlib from "zlib";
import { promisify } from "util";
import type Anthropic from "@anthropic-ai/sdk";
import { db, dbRO } from "./db";
import { fmtTime } from "./bw";
import { parseResim, resimFilePath, shortUnitName, type Resim } from "./resim-format";
import { resimStatus } from "./viewer-data";

const gunzip = promisify(zlib.gunzip);

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "query_db",
    description:
      "Ejecuta una consulta SQL de SOLO LECTURA (SELECT o WITH) sobre la base de datos de partidas. Tablas: games, game_players, build_order_events, game_observations, agent_notes, training_goals, goal_checks. Vistas útiles: v_my_games (mis partidas con mis stats), v_matchup_stats, v_map_stats, v_monthly_trend. Máximo 200 filas.",
    input_schema: {
      type: "object" as const,
      properties: { sql: { type: "string", description: "Consulta SELECT" } },
      required: ["sql"],
    },
  },
  {
    name: "get_replay_details",
    description:
      "Devuelve el detalle profundo de una partida: jugadores, chat completo, build order completo (incluye workers) por jugador con timestamps, y quién abandonó. Úsalo para analizar una partida específica a fondo.",
    input_schema: {
      type: "object" as const,
      properties: { game_id: { type: "string", description: "id de la partida (games.id)" } },
      required: ["game_id"],
    },
  },
  {
    name: "get_battle_report",
    description:
      "Devuelve las batallas REALES de una partida a partir de la re-simulación OpenBW: cada cluster de bajas (ventana de 15s, radio de 512px, mínimo 4 muertes) con inicio/fin en mm:ss, posición en el mapa, y qué unidades perdió cada jugador, más los totales de bajas por jugador. Es la única fuente de bajas reales: los comandos del replay no las contienen. Úsalo para analizar peleas, intercambios y errores de posicionamiento. Si la re-simulación aún no está lista devuelve su estado.",
    input_schema: {
      type: "object" as const,
      properties: { game_id: { type: "string", description: "id de la partida (games.id)" } },
      required: ["game_id"],
    },
  },
  {
    name: "list_notes",
    description:
      "Lee tu memoria persistente: todas las notas que has guardado sobre el jugador (debilidades, fortalezas, progreso, consejos dados). Llama esto AL INICIO de cada conversación.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "save_note",
    description:
      "Guarda una nota en tu memoria persistente. Úsala cuando detectes un patrón, des un consejo importante, o registres progreso.",
    input_schema: {
      type: "object" as const,
      properties: {
        area: {
          type: "string",
          enum: ["macro", "micro", "matchup", "build_order", "scouting", "progress", "general"],
        },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["area", "title", "content"],
    },
  },
  {
    name: "update_note",
    description: "Actualiza el contenido de una nota existente (por id).",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "number" },
        content: { type: "string" },
      },
      required: ["id", "content"],
    },
  },
  {
    name: "get_active_goal",
    description:
      "Devuelve el objetivo de entrenamiento activo con sus últimas evaluaciones automáticas (goal_checks).",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "create_goal",
    description:
      "Crea el objetivo de entrenamiento activo (ciclo dojo: UN solo foco a la vez; falla si ya hay uno activo). metric_keys disponibles: workers_at_6min, workers_at_8min, hotkey_pct, first_expansion_sec (usa comparator <=), max_worker_gap_sec (<=), army_supply_at_8min. Cada replay nuevo se evalúa automáticamente contra este objetivo.",
    input_schema: {
      type: "object" as const,
      properties: {
        area: { type: "string" },
        title: { type: "string", description: "En español, motivador y concreto" },
        metric_key: {
          type: "string",
          enum: [
            "workers_at_6min",
            "workers_at_8min",
            "hotkey_pct",
            "first_expansion_sec",
            "max_worker_gap_sec",
            "army_supply_at_8min",
          ],
        },
        target_value: { type: "number" },
        comparator: { type: "string", enum: [">=", "<="] },
        streak_required: { type: "number" },
      },
      required: ["area", "title", "metric_key", "target_value", "comparator"],
    },
  },
  {
    name: "complete_goal",
    description:
      "Cierra el objetivo activo como 'achieved' (logrado) o 'abandoned'. Al lograrlo, guarda también una nota de progreso y propón el siguiente foco.",
    input_schema: {
      type: "object" as const,
      properties: {
        goal_id: { type: "number" },
        status: { type: "string", enum: ["achieved", "abandoned"] },
      },
      required: ["goal_id", "status"],
    },
  },
];

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|analyze|set|do|call|execute)\b/i;

async function runQuery(sql: string): Promise<string> {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed) || FORBIDDEN_SQL.test(trimmed) || trimmed.includes(";")) {
    return "ERROR: solo se permiten consultas SELECT de una sola sentencia.";
  }
  const client = await dbRO().connect();
  try {
    await client.query("SET statement_timeout = 8000");
    const r = await client.query(trimmed);
    const rows = r.rows.slice(0, 200);
    return JSON.stringify({ rowCount: rows.length, rows });
  } catch (e) {
    return `ERROR SQL: ${(e as Error).message}`;
  } finally {
    client.release();
  }
}

export async function replayDetails(gameId: string): Promise<string> {
  if (!/^[a-f0-9]{16}$/.test(gameId)) return "ERROR: game_id inválido";
  const g = await db().query("SELECT * FROM games WHERE id = $1", [gameId]);
  if (!g.rowCount) return "ERROR: partida no encontrada";
  const game = g.rows[0];

  let chat: unknown[] = [];
  let leaves: unknown[] = [];
  try {
    const raw = JSON.parse(await fs.readFile(game.json_path, "utf8"));
    const headerPlayers = raw.Header.Players as { ID: number; SlotID: number; Name: string }[];
    const players = new Map(headerPlayers.map((p) => [p.ID, p.Name]));
    // Chat carries the real sender in SenderSlotID; PlayerID is unreliable there.
    const bySlot = new Map(headerPlayers.map((p) => [p.SlotID, p.Name]));
    chat = (raw.Computed.ChatCmds ?? []).map(
      (c: { Frame: number; PlayerID: number; SenderSlotID?: number; Message: string }) => ({
        time: fmtTime(Math.round(c.Frame / 23.81)),
        player: bySlot.get(c.SenderSlotID ?? -1) ?? players.get(c.PlayerID) ?? c.PlayerID,
        message: c.Message,
      })
    );
    leaves = (raw.Computed.LeaveGameCmds ?? []).map(
      (c: { Frame: number; PlayerID: number }) => ({
        time: fmtTime(Math.round(c.Frame / 23.81)),
        player: players.get(c.PlayerID) ?? c.PlayerID,
      })
    );
  } catch {
    // JSON on disk unavailable; DB data still useful
  }

  const players = (
    await db().query("SELECT * FROM game_players WHERE game_id = $1 ORDER BY team", [gameId])
  ).rows;
  const events = (
    await db().query(
      `SELECT player_name, seconds, kind, item FROM build_order_events
       WHERE game_id = $1 ORDER BY frame`,
      [gameId]
    )
  ).rows;
  const observations = (
    await db().query("SELECT severity, text FROM game_observations WHERE game_id = $1", [gameId])
  ).rows;

  const buildOrders: Record<string, string[]> = {};
  for (const e of events) {
    const line = `${fmtTime(e.seconds)} ${e.kind === "Upgrade" || e.kind === "Tech" ? "[" + e.kind + "] " : ""}${e.item}`;
    (buildOrders[e.player_name] ??= []).push(line);
  }
  // cap: workers make these long; keep first 120 entries per player
  for (const k of Object.keys(buildOrders)) buildOrders[k] = buildOrders[k].slice(0, 120);

  return JSON.stringify({
    game: {
      id: game.id, map: game.map_name, played_at: game.played_at, type: game.game_type,
      duration: fmtTime(game.duration_seconds), matchup: game.my_matchup ?? game.matchup,
      result: game.i_won === null ? "unknown" : game.i_won ? "win" : "loss",
      is_practice: game.is_practice,
    },
    players, observations, chat, leaves, build_orders: buildOrders,
  });
}

/** Reads and inflates the OpenBW dump for a game; null when it isn't there. */
export async function loadResim(gameId: string): Promise<Resim | null> {
  try {
    const raw = await gunzip(await fs.readFile(resimFilePath(gameId)));
    const view = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    return parseResim(view);
  } catch {
    return null;
  }
}

const BATTLE_WINDOW_SECONDS = 15;
const BATTLE_RADIUS_PX = 512;
const BATTLE_MIN_DEATHS = 4;

interface Cluster {
  fromFrame: number;
  toFrame: number;
  sumX: number;
  sumY: number;
  n: number;
  /** ownerIdx → typeId → count */
  losses: Map<number, Map<number, number>>;
}

/**
 * Battles = clusters of deaths in space and time. Deaths arrive frame-sorted,
 * so a cluster whose last death is older than the window can never grow again.
 */
export async function battleReport(gameId: string): Promise<string> {
  if (!/^[a-f0-9]{16}$/.test(gameId)) return "ERROR: game_id inválido";
  const resim = await loadResim(gameId);
  if (!resim) {
    const status = await resimStatus(gameId);
    return JSON.stringify({
      error: "sin re-simulación disponible para esta partida",
      resim_status: status,
      hint:
        status === "done"
          ? "el archivo no está en disco"
          : "la re-simulación aún no terminó; usa get_replay_details mientras tanto",
    });
  }

  const fps = resim.header.fps;
  const window = BATTLE_WINDOW_SECONDS * fps;
  const d = resim.deathIndex();
  const open: Cluster[] = [];
  const done: Cluster[] = [];

  for (let i = 0; i < d.count; i++) {
    const f = d.frame[i];
    const x = d.x[i];
    const y = d.y[i];
    // A battle spans at most one window: closing on the *start* keeps a busy
    // base from growing into one three-minute "fight".
    for (let c = open.length - 1; c >= 0; c--) {
      if (f - open[c].fromFrame > window) done.push(...open.splice(c, 1));
    }
    let best: Cluster | null = null;
    let bestDist = Infinity;
    for (const c of open) {
      const dx = x - c.sumX / c.n;
      const dy = y - c.sumY / c.n;
      const dist = Math.hypot(dx, dy);
      if (dist <= BATTLE_RADIUS_PX && dist < bestDist) {
        best = c;
        bestDist = dist;
      }
    }
    if (!best) {
      best = { fromFrame: f, toFrame: f, sumX: 0, sumY: 0, n: 0, losses: new Map() };
      open.push(best);
    }
    best.toFrame = f;
    best.sumX += x;
    best.sumY += y;
    best.n++;
    const perPlayer = best.losses.get(d.owner[i]) ?? new Map<number, number>();
    perPlayer.set(d.type[i], (perPlayer.get(d.type[i]) ?? 0) + 1);
    best.losses.set(d.owner[i], perPlayer);
  }
  done.push(...open);

  const battles = done
    .filter((c) => c.n >= BATTLE_MIN_DEATHS)
    .sort((a, b) => a.fromFrame - b.fromFrame)
    .map((c) => {
      const losses: Record<string, Record<string, number>> = {};
      for (const [owner, byType] of c.losses) {
        const byName: Record<string, number> = {};
        for (const [typeId, n] of byType) {
          const unit = shortUnitName(resim.typeName(typeId));
          byName[unit] = (byName[unit] ?? 0) + n;
        }
        losses[resim.playerName(owner)] = byName;
      }
      return {
        from: fmtTime(Math.round(c.fromFrame / fps)),
        to: fmtTime(Math.round(c.toFrame / fps)),
        location: { x: Math.round(c.sumX / c.n), y: Math.round(c.sumY / c.n) },
        total_bajas: c.n,
        losses,
      };
    });

  // Totals over the whole game, not just the clustered fights.
  const totals: Record<string, { total: number; por_unidad: Record<string, number> }> = {};
  for (const p of resim.header.players) totals[p.name] = { total: 0, por_unidad: {} };
  for (let i = 0; i < d.count; i++) {
    const t = totals[resim.playerName(d.owner[i])];
    if (!t) continue;
    t.total++;
    const unit = shortUnitName(resim.typeName(d.type[i]));
    t.por_unidad[unit] = (t.por_unidad[unit] ?? 0) + 1;
  }

  return JSON.stringify({
    game_id: gameId,
    fuente: "re-simulación OpenBW (bajas reales)",
    criterio: `ventana ${BATTLE_WINDOW_SECONDS}s · radio ${BATTLE_RADIUS_PX}px · mínimo ${BATTLE_MIN_DEATHS} bajas`,
    duracion: fmtTime(Math.round(resim.header.frames / fps)),
    battles,
    totales_por_jugador: totals,
  });
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "query_db":
      return runQuery(String(input.sql ?? ""));
    case "get_replay_details":
      return replayDetails(String(input.game_id ?? ""));
    case "get_battle_report":
      return battleReport(String(input.game_id ?? ""));
    case "list_notes": {
      const r = await db().query(
        "SELECT id, area, title, content, updated_at FROM agent_notes ORDER BY area, updated_at DESC"
      );
      return JSON.stringify(r.rows);
    }
    case "save_note": {
      const r = await db().query(
        "INSERT INTO agent_notes (area, title, content) VALUES ($1,$2,$3) RETURNING id",
        [input.area, input.title, input.content]
      );
      return JSON.stringify({ ok: true, id: r.rows[0].id });
    }
    case "update_note": {
      const r = await db().query(
        "UPDATE agent_notes SET content = $2, updated_at = now() WHERE id = $1 RETURNING id",
        [input.id, input.content]
      );
      return r.rowCount ? JSON.stringify({ ok: true }) : "ERROR: nota no encontrada";
    }
    case "get_active_goal": {
      const r = await db().query(`
        SELECT g.*, COALESCE(json_agg(json_build_object(
                 'game_id', c.game_id, 'measured', c.measured_value, 'passed', c.passed)
                 ORDER BY c.id DESC) FILTER (WHERE c.id IS NOT NULL), '[]'::json) AS checks
        FROM training_goals g LEFT JOIN goal_checks c ON c.goal_id = g.id
        WHERE g.status = 'active' GROUP BY g.id LIMIT 1`);
      return JSON.stringify(r.rows[0] ?? null);
    }
    case "create_goal": {
      try {
        const r = await db().query(
          `INSERT INTO training_goals (area, title, metric_key, target_value, comparator, streak_required)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [input.area, input.title, input.metric_key, input.target_value,
           input.comparator ?? ">=", input.streak_required ?? 5]
        );
        return JSON.stringify({ ok: true, id: r.rows[0].id });
      } catch (e) {
        return `ERROR: ${(e as Error).message} (¿ya hay un objetivo activo?)`;
      }
    }
    case "complete_goal": {
      const r = await db().query(
        `UPDATE training_goals SET status = $2, achieved_at = CASE WHEN $2 = 'achieved' THEN now() END
         WHERE id = $1 AND status = 'active' RETURNING id`,
        [input.goal_id, input.status]
      );
      return r.rowCount ? JSON.stringify({ ok: true }) : "ERROR: no hay objetivo activo con ese id";
    }
    default:
      return `ERROR: herramienta desconocida ${name}`;
  }
}
