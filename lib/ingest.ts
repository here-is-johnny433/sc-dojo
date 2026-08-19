import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import { db } from "./db";
import { parseReplay, ScrepResult, ScrepCmd } from "./screp";
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

function replaysDir(): string {
  return process.env.REPLAYS_DIR || path.join(process.cwd(), "data", "replays");
}

function myAliases(): Set<string> {
  return new Set(
    (process.env.MY_ALIASES || "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
  );
}

function cmdItem(c: ScrepCmd): string | null {
  return c.Unit?.Name ?? c.Upgrade?.Name ?? c.Tech?.Name ?? null;
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
  const players = header.Players.filter((p) => !p.Observer);
  const descs = new Map(rep.Computed.PlayerDescs.map((d) => [d.PlayerID, d]));
  const aliases = myAliases();
  const me = players.find((p) => aliases.has(p.Name.toLowerCase())) ?? null;
  const durationSeconds = framesToSeconds(header.Frames);
  const isPractice = players.some((p) => p.Type.Name === "Computer");

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

  // Per-player command-derived stats.
  const cmds = rep.Commands.Cmds ?? [];
  const cmdsByPlayer = new Map<number, ScrepCmd[]>();
  for (const c of cmds) {
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

  // Build order events for every non-observer player.
  type BOE = { pid: number; name: string; frame: number; kind: string; item: string; supply: number | null };
  const events: BOE[] = [];
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

  // ---- Heuristic observations (mine only, free of API cost) ----
  const observations: { severity: "info" | "warn" | "good"; text: string }[] = [];
  let myMetrics: Record<string, number> = {};
  if (me) {
    const mine = events.filter((e) => e.pid === me.ID);
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

    const myHotkeyPct = hotkeyPct(me.ID) ?? 0;

    myMetrics = {
      workers_at_6min: workersBySec(360),
      workers_at_8min: workersBySec(480),
      hotkey_pct: myHotkeyPct,
      first_expansion_sec: firstExpansionSec ?? 99999,
      max_worker_gap_sec: maxGap,
      army_supply_at_8min: armySupplyAt(480),
      last_worker_sec: lastWorkerSec,
    };

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
  }

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
                          my_team, my_name, my_race, i_won, is_practice, title, host, rep_path, json_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        id, opts.fileName, opts.source, header.StartTime, header.Frames, durationSeconds,
        header.Map, header.MapWidth, header.MapHeight, header.Type?.Name ?? null,
        matchup, myMatchup, winnerTeam, me?.Team ?? null, me?.Name ?? null,
        me ? me.Race.Name : null, iWon, isPractice, header.Title, header.Host, repPath, jsonPath,
      ]
    );

    for (const p of players) {
      const d = descs.get(p.ID);
      await client.query(
        `INSERT INTO game_players (game_id, player_id, name, race, team, apm, eapm, cmd_count,
                                   hotkey_pct, is_me, is_winner, is_computer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id, p.ID, p.Name, p.Race.Name, p.Team, d?.APM ?? null, d?.EAPM ?? null,
          d?.CmdCount ?? null, hotkeyPct(p.ID), me?.ID === p.ID,
          winnerTeam ? p.Team === winnerTeam : null, p.Type.Name === "Computer",
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

    for (const o of observations) {
      await client.query(
        "INSERT INTO game_observations (game_id, severity, text) VALUES ($1,$2,$3)",
        [id, o.severity, o.text]
      );
    }

    // Evaluate the active training goal against this game (Dojo cycle).
    if (me && Object.keys(myMetrics).length) {
      const goal = await client.query(
        "SELECT id, metric_key, target_value, comparator FROM training_goals WHERE status = 'active' LIMIT 1"
      );
      if (goal.rowCount) {
        const g = goal.rows[0];
        const measured = myMetrics[g.metric_key];
        if (measured !== undefined) {
          const passed =
            g.comparator === "<=" ? measured <= g.target_value : measured >= g.target_value;
          await client.query(
            `INSERT INTO goal_checks (goal_id, game_id, measured_value, passed)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [g.id, id, measured, passed]
          );
        }
      }
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
