// Espectro de rendimiento — five 0–10 variables per player per game, visible
// for EVERY player in the game (not just "me"), so the game page can compare
// side by side and the profile page can trend them over time.
//
//   mechanics · EAPM + hotkey usage                (screp — always available)
//   economy   · worker production + expansion time (resim when done, screp otherwise)
//   macro     · unspent resources + supply blocks  (resim only)
//   combat    · army trade efficiency              (resim only)
//   build     · upgrade/tech timing                (screp — always available)
//
// 0 = noob, 10 = pro. Anchors are piecewise-linear curves calibrated to public
// ladder wisdom (D rank ≈ 2–3, C ≈ 5, B ≈ 7, A/pro ≈ 9+); tune them here and
// re-run `pnpm scores --force`.
//
// Rows are cached in player_scores. A game scored before its re-simulation
// finished is upgraded (recomputed with the dump) the next time it is ensured.
//
// Server-only: reads the DB and the resim dumps.

import { db } from "./db";
import { FPS, WORKERS, RESOURCE_DEPOTS } from "./bw";
import { loadResim, supplyBlocks } from "./game-series";
import { isWorkerType, shortUnitName, type Resim } from "./resim-format";
import { unitValue } from "./unit-costs";

export const SCORE_KEYS = ["mechanics", "economy", "macro", "combat", "build"] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];

export const SCORE_LABELS: Record<ScoreKey, string> = {
  mechanics: "Mecánica",
  economy: "Economía",
  macro: "Macro (gasto)",
  combat: "Combate",
  build: "Build / Tech",
};

export const SCORE_HINTS: Record<ScoreKey, string> = {
  mechanics: "EAPM y uso de hotkeys",
  economy: "producción de workers y expansión",
  macro: "recursos sin gastar y supply blocks",
  combat: "eficiencia de intercambios (valor perdido vs destruido)",
  build: "timing de upgrades y tech",
};

export interface PlayerScore {
  game_id: string;
  player_id: number;
  mechanics: number | null;
  economy: number | null;
  macro: number | null;
  combat: number | null;
  build: number | null;
  overall: number | null;
  raw: Record<string, number | null>;
  with_resim: boolean;
}

type Pt = [number, number];

/** Piecewise-linear interpolation, clamped to the first/last anchor. */
function curve(x: number, pts: Pt[]): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const clamp10 = (v: number) => Math.min(10, Math.max(0, v));

interface PlayerRow {
  player_id: number;
  team: number;
  apm: number | null;
  eapm: number | null;
  hotkey_pct: number | null;
  is_computer: boolean;
}

interface EventRow {
  player_id: number;
  seconds: number;
  kind: string;
  item: string;
}

// ---------- individual variables ----------

function mechanicsScore(p: PlayerRow): { score: number | null; raw: Record<string, number | null> } {
  const raw = { eapm: p.eapm, apm: p.apm, hotkey_pct: p.hotkey_pct };
  if (p.eapm == null && p.hotkey_pct == null) return { score: null, raw };
  const eapmS = curve(p.eapm ?? 0, [[0, 0], [30, 2], [60, 4], [100, 6], [150, 8], [220, 10]]);
  const hkS = curve(p.hotkey_pct ?? 0, [[0, 0], [10, 2.5], [20, 4.5], [35, 7], [50, 9], [60, 10]]);
  return { score: r1(clamp10(0.7 * eapmS + 0.3 * hkS)), raw };
}

function economyScore(
  p: PlayerRow,
  events: EventRow[],
  duration: number,
  resim: Resim | null,
  slot: number | undefined
): { score: number | null; raw: Record<string, number | null> } {
  const mine = events.filter((e) => e.player_id === p.player_id);
  const horizon = Math.min(480, duration);
  // No commands recorded for this player and no dump: absence of data, not a
  // 0-worker game — don't grade it.
  if (!mine.length && (!resim || slot === undefined)) {
    return { score: null, raw: { workers_8min: null, workers_produced: null, first_expansion_sec: null } };
  }
  const produced = mine.filter(
    (e) => WORKERS.has(e.item) && (e.kind === "Train" || e.kind === "Unit Morph") && e.seconds <= horizon
  ).length;

  // Actual living workers at the horizon when the dump exists; otherwise the
  // command estimate (start workers + trained, ignores losses).
  let workersAtH: number | null = null;
  if (resim && slot !== undefined) {
    const i = resim.sampleAtFrame(Math.round(horizon * resim.header.fps));
    if (i >= 0) {
      let n = 0;
      const count = resim.unitCount(i);
      for (let k = 0; k < count; k++) {
        if (resim.unitOwner(i, k) !== slot) continue;
        if (isWorkerType(resim.typeInfo(resim.unitType(i, k)))) n++;
      }
      workersAtH = n;
    }
  }
  const workers = workersAtH ?? 4 + produced;
  // Short game: project to the 8-minute benchmark so a 5-minute rush isn't
  // punished for not having 8 minutes of workers.
  const adj = duration >= 480 ? workers : 4 + ((workers - 4) * 480) / Math.max(duration, 120);
  const wS = curve(adj, [[8, 1], [16, 3], [24, 5], [33, 6.5], [42, 8], [55, 10]]);

  const exp = mine.find((e) => e.kind === "Build" && RESOURCE_DEPOTS.has(e.item));
  const firstExpSec = exp ? exp.seconds : null;
  let eS: number | null;
  if (firstExpSec != null) {
    eS = curve(firstExpSec, [[180, 10], [360, 8], [480, 6], [600, 4], [900, 2]]);
  } else if (duration > 480) {
    eS = 1; // long game on one base
  } else {
    eS = null; // short game — no expansion is normal
  }

  const raw = { workers_8min: workers, workers_produced: produced, first_expansion_sec: firstExpSec };
  const score = eS == null ? wS : 0.65 * wS + 0.35 * eS;
  return { score: r1(clamp10(score)), raw };
}

function macroScore(
  duration: number,
  resim: Resim | null,
  slot: number | undefined
): { score: number | null; raw: Record<string, number | null> } {
  if (!resim || slot === undefined || duration < 120) {
    return { score: null, raw: { avg_unspent: null, supply_block_pct: null } };
  }
  const fps = resim.header.fps;
  const fromFrame = 120 * fps; // the first 2 minutes are the same for everyone
  let sum = 0;
  let n = 0;
  for (let i = 0; i < resim.sampleCount; i++) {
    if (resim.frameAt(i) < fromFrame) continue;
    sum += resim.minerals(i, slot) + resim.gas(i, slot);
    n++;
  }
  if (n === 0) return { score: null, raw: { avg_unspent: null, supply_block_pct: null } };
  const avgUnspent = Math.round(sum / n);
  const uS = curve(avgUnspent, [[300, 10], [600, 8], [1000, 6], [1500, 4], [2500, 2], [4000, 0.5]]);

  const blockPct = r1((supplyBlocks(resim, slot, fps).totalSec / Math.max(duration, 1)) * 100);
  const bS = curve(blockPct, [[0, 10], [2, 8.5], [5, 7], [10, 4.5], [15, 2.5], [25, 1]]);

  return {
    score: r1(clamp10(0.6 * uS + 0.4 * bS)),
    raw: { avg_unspent: avgUnspent, supply_block_pct: blockPct },
  };
}

/**
 * Team-level trade efficiency: value the opposing team lost vs value your team
 * lost. Kills can't be attributed per player from samples, so teammates share
 * the score — exact in 1v1, a shared grade in team games.
 */
function combatScores(
  players: PlayerRow[],
  resim: Resim | null
): Map<number, { score: number | null; raw: Record<string, number | null> }> {
  const out = new Map<number, { score: number | null; raw: Record<string, number | null> }>();
  const empty = { score: null, raw: { value_lost: null, value_killed: null, trade_ratio: null } };
  if (!resim) {
    for (const p of players) out.set(p.player_id, empty);
    return out;
  }

  const lostByPlayer = new Map<number, number>(); // screp player_id -> value lost
  const d = resim.deathIndex();
  for (let i = 0; i < d.count; i++) {
    const info = resim.typeInfo(d.type[i]);
    if (info.building) continue;
    const pid = resim.header.players[d.owner[i]]?.id;
    if (pid === undefined) continue;
    const v = unitValue(shortUnitName(info.name));
    lostByPlayer.set(pid, (lostByPlayer.get(pid) ?? 0) + v);
  }

  const teamLost = new Map<number, number>();
  for (const p of players) {
    teamLost.set(p.team, (teamLost.get(p.team) ?? 0) + (lostByPlayer.get(p.player_id) ?? 0));
  }

  for (const p of players) {
    const own = teamLost.get(p.team) ?? 0;
    let opp = 0;
    for (const [team, v] of teamLost) if (team !== p.team) opp += v;
    if (own + opp < 400) {
      // barely any fighting — a score would be noise
      out.set(p.player_id, empty);
      continue;
    }
    const ratio = (opp + 50) / (own + 50); // smoothed so a flawless skirmish isn't ∞
    // Softer slope (a 10 needs ~4-5× value traded, not 2.8×), capped below a
    // perfect score, and shrunk toward neutral when little value changed hands
    // — a won skirmish is evidence, not a pro grade.
    const rawScore = 5.5 + 2.2 * Math.log2(ratio);
    const volume = own + opp;
    const confidence = volume / (volume + 800);
    const score = r1(Math.min(9.8, Math.max(0.4, 5.5 + confidence * (rawScore - 5.5))));
    out.set(p.player_id, {
      score,
      raw: {
        value_lost: Math.round(lostByPlayer.get(p.player_id) ?? 0),
        value_killed: Math.round(opp),
        trade_ratio: r1(ratio),
      },
    });
  }
  return out;
}

function buildScore(
  p: PlayerRow,
  events: EventRow[],
  duration: number
): { score: number | null; raw: Record<string, number | null> } {
  const mine = events.filter((e) => e.player_id === p.player_id);
  // No commands recorded at all for this player → data absent, not "no tech".
  if (!mine.length) {
    return { score: null, raw: { first_upgrade_sec: null, upgrades_10min: null } };
  }
  const upgrades = mine
    .filter((e) => e.kind === "Upgrade" || e.kind === "Tech")
    .sort((a, b) => a.seconds - b.seconds);
  const firstSec = upgrades.length ? upgrades[0].seconds : null;
  const by10 = upgrades.filter((e) => e.seconds <= 600).length;
  const raw = { first_upgrade_sec: firstSec, upgrades_10min: by10 };

  if (duration < 300) return { score: null, raw }; // rush — tech says nothing yet

  const cS = curve(by10, [[0, 1], [1, 4], [2, 6], [3, 7.5], [4, 8.5], [6, 10]]);
  const tS =
    firstSec != null
      ? curve(firstSec, [[240, 10], [300, 9], [360, 8], [480, 6], [600, 4], [800, 2]])
      : duration >= 480
        ? 1.5
        : null;
  const score = tS == null ? cS : 0.5 * cS + 0.5 * tS;
  return { score: r1(clamp10(score)), raw };
}

// ---------- orchestration ----------

/** Compute (or recompute) and store the score rows of one game. */
export async function computePlayerScores(gameId: string): Promise<PlayerScore[]> {
  const g = await db().query(
    "SELECT duration_seconds, frames, resim_status FROM games WHERE id = $1",
    [gameId]
  );
  if (!g.rowCount) return [];
  const duration: number = g.rows[0].duration_seconds ?? Math.round((g.rows[0].frames ?? 0) / FPS);

  const pr = await db().query(
    `SELECT player_id, team, apm, eapm, hotkey_pct, is_computer
     FROM game_players WHERE game_id = $1 ORDER BY player_id`,
    [gameId]
  );
  const players: PlayerRow[] = pr.rows;
  if (!players.length) return [];

  const ev = await db().query(
    `SELECT player_id, seconds, kind, item FROM build_order_events WHERE game_id = $1`,
    [gameId]
  );
  const events: EventRow[] = ev.rows;

  const resim = g.rows[0].resim_status === "done" ? await loadResim(gameId) : null;
  const slots = new Map<number, number>();
  if (resim) {
    for (const p of players) {
      const i = resim.indexOfPlayerId(p.player_id);
      if (i >= 0) slots.set(p.player_id, i);
    }
  }

  const combat = combatScores(players, resim);
  const rows: PlayerScore[] = [];
  for (const p of players) {
    const mech = mechanicsScore(p);
    const eco = economyScore(p, events, duration, resim, slots.get(p.player_id));
    const mac = macroScore(duration, resim, slots.get(p.player_id));
    const com = combat.get(p.player_id) ?? { score: null, raw: {} };
    const bld = buildScore(p, events, duration);

    const parts = [mech.score, eco.score, mac.score, com.score, bld.score].filter(
      (s): s is number => s != null
    );
    rows.push({
      game_id: gameId,
      player_id: p.player_id,
      mechanics: mech.score,
      economy: eco.score,
      macro: mac.score,
      combat: com.score,
      build: bld.score,
      overall: parts.length ? r1(parts.reduce((a, b) => a + b, 0) / parts.length) : null,
      raw: { ...mech.raw, ...eco.raw, ...mac.raw, ...com.raw, ...bld.raw },
      with_resim: !!resim,
    });
  }

  for (const s of rows) {
    await db().query(
      `INSERT INTO player_scores (game_id, player_id, mechanics, economy, macro, combat, build, overall, raw, with_resim, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (game_id, player_id) DO UPDATE SET
         mechanics = EXCLUDED.mechanics, economy = EXCLUDED.economy, macro = EXCLUDED.macro,
         combat = EXCLUDED.combat, build = EXCLUDED.build, overall = EXCLUDED.overall,
         raw = EXCLUDED.raw, with_resim = EXCLUDED.with_resim, computed_at = now()`,
      [
        s.game_id, s.player_id, s.mechanics, s.economy, s.macro, s.combat, s.build,
        s.overall, JSON.stringify(s.raw), s.with_resim,
      ]
    );
  }
  return rows;
}

/**
 * Cached read: computes on first sight of a game and recomputes once the
 * re-simulation lands (rows scored without the dump are marked with_resim =
 * false). Call it from any page that shows scores.
 */
export async function ensurePlayerScores(gameId: string): Promise<PlayerScore[]> {
  const r = await db().query(
    `SELECT s.*, g.resim_status FROM player_scores s
     JOIN games g ON g.id = s.game_id WHERE s.game_id = $1 ORDER BY s.player_id`,
    [gameId]
  );
  if (r.rowCount && !(r.rows[0].resim_status === "done" && r.rows.some((x) => !x.with_resim))) {
    return r.rows;
  }
  return computePlayerScores(gameId);
}
