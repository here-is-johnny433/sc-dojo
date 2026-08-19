import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import type { PoolClient } from "pg";
import { db } from "./db";
import { parseReplay, ScrepResult, ScrepCmd, ScrepPlayer } from "./screp";
import {
  framesToSeconds,
  fmtTime,
  WORKERS,
  RESOURCE_DEPOTS,
  BUILD_KINDS,
  SUPPLY_COST,
  RACE_LETTER,
} from "./bw";

export interface IngestResult {
  id: string;
  status: "imported" | "duplicate" | "error";
  detail?: string;
}

export interface BuildEvent {
  pid: number;
  name: string;
  frame: number;
  kind: string;
  item: string;
  supply: number | null;
}

export interface Observation {
  severity: "info" | "warn" | "good";
  text: string;
}

export interface PlayerAnalysis {
  metrics: Record<string, number>;
  observations: Observation[];
}

function replaysDir(): string {
  return process.env.REPLAYS_DIR || path.join(process.cwd(), "data", "replays");
}

function cmdItem(c: ScrepCmd): string | null {
  return c.Unit?.Name ?? c.Upgrade?.Name ?? c.Tech?.Name ?? null;
}

/** alias en minúsculas → user_id, solo de usuarios activos. */
export async function aliasMap(): Promise<Map<string, number>> {
  const r = await db().query(
    `SELECT LOWER(a.alias) AS alias, a.user_id FROM player_aliases a
     JOIN users u ON u.id = a.user_id WHERE u.active`
  );
  return new Map(r.rows.map((row) => [row.alias as string, Number(row.user_id)]));
}

/** Build order events + hotkey ratio, derivados solo de los comandos. */
export function replayEvents(rep: ScrepResult): {
  players: ScrepPlayer[];
  events: BuildEvent[];
  hotkeyPct: (pid: number) => number | null;
  durationSeconds: number;
} {
  const players = rep.Header.Players.filter((p) => !p.Observer);
  const cmdsByPlayer = new Map<number, ScrepCmd[]>();
  for (const c of rep.Commands.Cmds ?? []) {
    const arr = cmdsByPlayer.get(c.PlayerID);
    if (arr) arr.push(c);
    else cmdsByPlayer.set(c.PlayerID, [c]);
  }
  const hotkeyPct = (pid: number): number | null => {
    const list = cmdsByPlayer.get(pid);
    if (!list?.length) return null;
    const hk = list.filter((c) => c.Type.Name === "Hotkey").length;
    return Math.round((1000 * hk) / list.length) / 10;
  };

  const events: BuildEvent[] = [];
  for (const p of players) {
    for (const c of cmdsByPlayer.get(p.ID) ?? []) {
      if (!BUILD_KINDS.has(c.Type.Name)) continue;
      const item = cmdItem(c);
      if (!item) continue;
      const isUnit = c.Type.Name === "Train" || c.Type.Name === "Unit Morph";
      events.push({
        pid: p.ID,
        name: p.Name,
        frame: c.Frame,
        kind: c.Type.Name,
        item,
        supply: isUnit ? SUPPLY_COST[item] ?? null : null,
      });
    }
  }
  return { players, events, hotkeyPct, durationSeconds: framesToSeconds(rep.Header.Frames) };
}

/**
 * Heurísticas de macro para un jugador (gratis, sin API): las métricas que
 * evalúan los objetivos del dojo y las observaciones que verá en la partida.
 */
export function analyzePlayer(
  playerId: number,
  events: BuildEvent[],
  hotkeyPct: number | null,
  durationSeconds: number
): PlayerAnalysis {
  const mine = events.filter((e) => e.pid === playerId);
  const workerFrames = mine
    .filter((e) => WORKERS.has(e.item) && (e.kind === "Train" || e.kind === "Unit Morph"))
    .map((e) => e.frame);

  const workersBySec = (s: number) => workerFrames.filter((f) => framesToSeconds(f) <= s).length;
  const lastWorkerSec = workerFrames.length
    ? framesToSeconds(workerFrames[workerFrames.length - 1])
    : 0;

  // Longest gap without starting a worker (after the first one, before game end).
  let maxGap = 0;
  const gapPoints = [...workerFrames.map(framesToSeconds), durationSeconds];
  for (let i = 1; i < gapPoints.length; i++) {
    maxGap = Math.max(maxGap, gapPoints[i] - gapPoints[i - 1]);
  }

  const expansions = mine.filter((e) => e.kind === "Build" && RESOURCE_DEPOTS.has(e.item));
  const firstExpansionSec = expansions.length ? framesToSeconds(expansions[0].frame) : null;

  const armySupplyAt = (s: number) =>
    mine
      .filter(
        (e) =>
          (e.kind === "Train" || e.kind === "Unit Morph") &&
          !WORKERS.has(e.item) &&
          framesToSeconds(e.frame) <= s
      )
      .reduce((sum, e) => sum + (e.supply ?? 0), 0);

  const myHotkeyPct = hotkeyPct ?? 0;

  const metrics: Record<string, number> = {
    workers_at_6min: workersBySec(360),
    workers_at_8min: workersBySec(480),
    hotkey_pct: myHotkeyPct,
    first_expansion_sec: firstExpansionSec ?? 99999,
    max_worker_gap_sec: maxGap,
    army_supply_at_8min: armySupplyAt(480),
    last_worker_sec: lastWorkerSec,
  };

  const observations: Observation[] = [];
  if (durationSeconds > 360 && lastWorkerSec < durationSeconds * 0.7) {
    observations.push({
      severity: "warn",
      text: `Dejaste de producir workers en ${fmtTime(lastWorkerSec)} (la partida duró ${fmtTime(durationSeconds)}). Producción constante de workers = economía viva.`,
    });
  }
  if (durationSeconds > 240 && maxGap > 60) {
    observations.push({
      severity: "warn",
      text: `Tu mayor pausa sin iniciar un worker fue de ${maxGap}s. Meta: nunca más de ~30s con la base ociosa.`,
    });
  }
  if (myHotkeyPct < 20) {
    observations.push({
      severity: "warn",
      text: `Solo ${myHotkeyPct}% de tus acciones usan hotkeys. Subir el uso de grupos de control es la vía más rápida a APM útil.`,
    });
  } else if (myHotkeyPct >= 35) {
    observations.push({ severity: "good", text: `Buen uso de hotkeys: ${myHotkeyPct}% de tus acciones.` });
  }
  if (durationSeconds > 600 && firstExpansionSec === null) {
    observations.push({
      severity: "warn",
      text: `Partida de ${fmtTime(durationSeconds)} sin expansión. Una base no sostiene el late game.`,
    });
  } else if (firstExpansionSec !== null) {
    observations.push({
      severity: "info",
      text: `Primera expansión en ${fmtTime(firstExpansionSec)}.`,
    });
  }
  return { metrics, observations };
}

/**
 * Guarda las observaciones del usuario para una partida (reemplazando las
 * suyas, no las de los demás) y evalúa SU objetivo activo contra las métricas.
 */
export async function persistPlayerAnalysis(
  client: PoolClient,
  gameId: string,
  userId: number,
  analysis: PlayerAnalysis
): Promise<void> {
  await client.query("DELETE FROM game_observations WHERE game_id = $1 AND user_id = $2", [
    gameId,
    userId,
  ]);
  for (const o of analysis.observations) {
    await client.query(
      "INSERT INTO game_observations (game_id, user_id, severity, text) VALUES ($1,$2,$3,$4)",
      [gameId, userId, o.severity, o.text]
    );
  }

  // Ciclo dojo: cada usuario tiene como mucho un objetivo activo propio.
  const goal = await client.query(
    `SELECT id, metric_key, target_value, comparator FROM training_goals
     WHERE status = 'active' AND user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!goal.rowCount) return;
  const g = goal.rows[0];
  const measured = analysis.metrics[g.metric_key];
  if (measured === undefined) return;
  const passed = g.comparator === "<=" ? measured <= g.target_value : measured >= g.target_value;
  await client.query(
    `INSERT INTO goal_checks (goal_id, game_id, measured_value, passed)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [g.id, gameId, measured, passed]
  );
}

export async function ingestReplay(
  buffer: Buffer,
  opts: { fileName: string; source: string }
): Promise<IngestResult> {
  const id = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);

  const existing = await db().query("SELECT 1 FROM games WHERE id = $1", [id]);
  if (existing.rowCount) return { id, status: "duplicate" };

  let rep: ScrepResult;
  try {
    rep = await parseReplay(buffer);
  } catch (e) {
    return { id, status: "error", detail: `screp failed: ${(e as Error).message}` };
  }

  const header = rep.Header;
  const descs = new Map(rep.Computed.PlayerDescs.map((d) => [d.PlayerID, d]));
  const { players, events, hotkeyPct, durationSeconds } = replayEvents(rep);
  const isPractice = players.some((p) => p.Type.Name === "Computer");

  // Cada jugador registrado (por alias) queda vinculado a su usuario.
  const aliases = await aliasMap();
  const userOf = new Map<number, number>();
  for (const p of players) {
    const userId = aliases.get(p.Name.toLowerCase());
    if (userId !== undefined) userOf.set(p.ID, userId);
  }
  // El primero emparejado sigue alimentando games.my_* / is_me (compat legacy).
  const me = players.find((p) => userOf.has(p.ID)) ?? null;

  // Matchups: raw ("TTvPZ") and from my perspective ("PZ vs TT").
  const teams = new Map<number, string[]>();
  for (const p of players) {
    const letter = RACE_LETTER[p.Race.Name] ?? "?";
    teams.set(p.Team, [...(teams.get(p.Team) ?? []), letter]);
  }
  const teamStr = (t: number) => (teams.get(t) ?? []).sort().join("");
  const matchup = [...teams.keys()].sort().map(teamStr).join("v");
  let myMatchup: string | null = null;
  if (me) {
    const oppTeams = [...teams.keys()].filter((t) => t !== me.Team).map(teamStr).sort();
    myMatchup = `${teamStr(me.Team)} vs ${oppTeams.join("+")}`;
  }

  const winnerTeam = rep.Computed.WinnerTeam || null;
  const iWon = me && winnerTeam ? me.Team === winnerTeam : null;

  // ---- Heuristic observations, por cada jugador registrado ----
  const analyses = [...userOf.entries()].map(([playerId, userId]) => ({
    userId,
    analysis: analyzePlayer(playerId, events, hotkeyPct(playerId), durationSeconds),
  }));

  // ---- Persist everything atomically, then files ----
  const repDir = path.join(replaysDir(), "reps");
  const jsonDir = path.join(replaysDir(), "parsed");
  await fs.mkdir(repDir, { recursive: true });
  await fs.mkdir(jsonDir, { recursive: true });
  const repPath = path.join(repDir, `${id}.rep`);
  const jsonPath = path.join(jsonDir, `${id}.json`);

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO games (id, file_name, source, played_at, frames, duration_seconds, map_name,
                          map_width, map_height, game_type, matchup, my_matchup, winner_team,
                          my_team, my_name, my_race, i_won, is_practice, title, host, rep_path, json_path,
                          resim_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        id, opts.fileName, opts.source, header.StartTime, header.Frames, durationSeconds,
        header.Map, header.MapWidth, header.MapHeight, header.Type?.Name ?? null,
        matchup, myMatchup, winnerTeam, me?.Team ?? null, me?.Name ?? null,
        me ? me.Race.Name : null, iWon, isPractice, header.Title, header.Host, repPath, jsonPath,
        // Capa B queue: OpenBW cannot simulate games with a Computer player.
        isPractice ? "skipped" : "pending",
      ]
    );

    for (const p of players) {
      const d = descs.get(p.ID);
      await client.query(
        `INSERT INTO game_players (game_id, player_id, name, race, team, apm, eapm, cmd_count,
                                   hotkey_pct, is_me, is_winner, is_computer, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id, p.ID, p.Name, p.Race.Name, p.Team, d?.APM ?? null, d?.EAPM ?? null,
          d?.CmdCount ?? null, hotkeyPct(p.ID), me?.ID === p.ID,
          winnerTeam ? p.Team === winnerTeam : null, p.Type.Name === "Computer",
          userOf.get(p.ID) ?? null,
        ]
      );
    }

    for (const e of events) {
      await client.query(
        `INSERT INTO build_order_events (game_id, player_id, player_name, frame, seconds, kind, item, supply_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, e.pid, e.name, e.frame, framesToSeconds(e.frame), e.kind, e.item, e.supply]
      );
    }

    for (const { userId, analysis } of analyses) {
      await persistPlayerAnalysis(client, id, userId, analysis);
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return { id, status: "error", detail: (e as Error).message };
  } finally {
    client.release();
  }

  await fs.writeFile(repPath, buffer);
  await fs.writeFile(jsonPath, JSON.stringify(rep));

  return { id, status: "imported" };
}
