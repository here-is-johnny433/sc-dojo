// Per-game time series for the detail page — "layer B" numbers, not estimates.
//
// Two sources are folded into ONE shared time grid so every chart on the page
// lines up on the x axis:
//   · the OpenBW re-simulation dump (banked resources, supply, live units), and
//   · the parsed screp commands (hotkey usage, which needs no re-simulation).
//
// The dump holds ~4000 samples (one every 12 frames ≈ 0.5 s). Recharts chokes
// on that and no one can read it, so the grid is ~200 points: values are POINT
// SAMPLED at each grid time (never averaged — averaging a bank balance lies),
// while peaks and supply blocks are computed at FULL resolution and reported
// separately, so nothing interesting hides between two grid points.
//
// Server-only: reads the filesystem. Do not import from a client component.

import fs from "fs/promises";
import zlib from "zlib";
import { promisify } from "util";
import { db } from "./db";
import { FPS } from "./bw";
import { parseResim, resimFilePath, isWorkerType, type Resim } from "./resim-format";

const gunzip = promisify(zlib.gunzip);

/** Grid resolution: enough to see a 10-second dip, few enough to render fast. */
const MIN_POINTS = 60;
const MAX_POINTS = 220;
const SECONDS_PER_POINT = 9;

/** Rolling window for the hotkey ratio. */
const HOTKEY_WINDOW_SECONDS = 60;

/** A supply block shorter than this is just the depot being one second late. */
const MIN_BLOCK_SECONDS = 5;

/** Supply is stored in half units, so the 200 cap is 400 here. */
const SUPPLY_CAP_HALF = 400;

export interface SeriesPlayer {
  id: number; // screp PlayerID — the key suffix of every series column
  name: string;
  race: string;
  team: number;
  isMe: boolean;
}

/** One grid point. Columns are `<prefix><playerId>`; null = no data there. */
export interface SeriesPoint {
  t: number; // seconds since game start
  [column: string]: number | null;
}

export interface SupplyBlock {
  fromSec: number;
  toSec: number;
}

export interface PlayerBlocks {
  blocks: SupplyBlock[];
  totalSec: number;
}

export interface ResourcePeak {
  minerals: number;
  mineralsSec: number;
  gas: number;
  gasSec: number;
}

export interface HotkeyGroup {
  group: number;
  assigns: number;
  /** Select + Add — i.e. how often the group was actually recalled. */
  uses: number;
}

export interface GameSeries {
  hasResim: boolean;
  resimStatus: string;
  durationSeconds: number;
  players: SeriesPlayer[];
  /** `m<id>` = minerals banked, `g<id>` = gas banked. */
  resources: SeriesPoint[];
  peaks: Record<number, ResourcePeak>;
  /** `u<id>` = supply used, `x<id>` = supply max (both in whole supply). */
  supply: SeriesPoint[];
  blocks: Record<number, PlayerBlocks>;
  /** `a<id>` = supply of living non-worker units. */
  army: SeriesPoint[];
  /** `h<id>` = % of that minute's commands that were hotkeys. */
  hotkeys: SeriesPoint[];
  hotkeyGroups: Record<number, HotkeyGroup[]>;
}

interface RawCmd {
  Frame: number;
  PlayerID: number;
  Type?: { Name: string };
  HotkeyType?: { Name: string };
  Group?: number;
}

/** Index of the first element >= value, in a sorted array. */
function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const countInRange = (arr: number[], from: number, to: number) =>
  lowerBound(arr, to) - lowerBound(arr, from);

function gridSeconds(durationSeconds: number): number[] {
  const n = Math.min(
    MAX_POINTS,
    Math.max(MIN_POINTS, Math.round(durationSeconds / SECONDS_PER_POINT))
  );
  const last = Math.max(1, durationSeconds);
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(Math.round((k * last) / (n - 1)));
  return out;
}

/** Living workers per player at one sample — the army series subtracts these. */
function workersAt(resim: Resim, i: number): Int32Array {
  const out = new Int32Array(resim.playerCount);
  const n = resim.unitCount(i);
  for (let k = 0; k < n; k++) {
    const owner = resim.unitOwner(i, k);
    if (owner >= resim.playerCount) continue;
    if (isWorkerType(resim.typeInfo(resim.unitType(i, k)))) out[owner]++;
  }
  return out;
}

/**
 * Stretches where used == max, at the dump's own resolution. Runs shorter than
 * MIN_BLOCK_SECONDS and games already at the 200 cap are not blocks: the first
 * is noise, the second is a full army, which is the goal and not a mistake.
 */
function supplyBlocks(resim: Resim, p: number, fps: number): PlayerBlocks {
  const blocks: SupplyBlock[] = [];
  let total = 0;
  let openFrom = -1;
  const close = (toFrame: number) => {
    if (openFrom < 0) return;
    const from = openFrom / fps;
    const to = toFrame / fps;
    if (to - from >= MIN_BLOCK_SECONDS) {
      blocks.push({ fromSec: Math.round(from), toSec: Math.round(to) });
      total += to - from;
    }
    openFrom = -1;
  };

  for (let i = 0; i < resim.sampleCount; i++) {
    const max = resim.supplyMax(i, p);
    const blocked = max > 0 && max < SUPPLY_CAP_HALF && resim.supplyUsed(i, p) >= max;
    if (blocked && openFrom < 0) openFrom = resim.frameAt(i);
    else if (!blocked) close(resim.frameAt(i));
  }
  if (resim.sampleCount > 0) close(resim.frameAt(resim.sampleCount - 1));
  return { blocks, totalSec: Math.round(total) };
}

async function loadResim(gameId: string): Promise<Resim | null> {
  try {
    const raw = await gunzip(await fs.readFile(resimFilePath(gameId)));
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    return parseResim(buf);
  } catch {
    return null;
  }
}

/** Hotkey series + per-group tallies, straight from the commands. */
function hotkeySeries(
  cmds: RawCmd[],
  players: SeriesPlayer[],
  grid: number[],
  fps: number
): { hotkeys: SeriesPoint[]; hotkeyGroups: Record<number, HotkeyGroup[]> } {
  const all = new Map<number, number[]>();
  const hk = new Map<number, number[]>();
  const groups = new Map<number, Map<number, HotkeyGroup>>();
  for (const p of players) {
    all.set(p.id, []);
    hk.set(p.id, []);
    groups.set(p.id, new Map());
  }

  for (const c of cmds) {
    const frames = all.get(c.PlayerID);
    if (!frames) continue;
    frames.push(c.Frame);
    if (c.Type?.Name !== "Hotkey") continue;
    hk.get(c.PlayerID)!.push(c.Frame);
    const g = c.Group ?? 0;
    const per = groups.get(c.PlayerID)!;
    const entry = per.get(g) ?? { group: g, assigns: 0, uses: 0 };
    if (c.HotkeyType?.Name === "Assign") entry.assigns++;
    else entry.uses++; // Select + Add
    per.set(g, entry);
  }
  // Commands arrive frame-sorted, but do not rely on it for the binary search.
  for (const arr of all.values()) arr.sort((a, b) => a - b);
  for (const arr of hk.values()) arr.sort((a, b) => a - b);

  const hotkeys: SeriesPoint[] = grid.map((t) => {
    const row: SeriesPoint = { t };
    const from = Math.max(0, t - HOTKEY_WINDOW_SECONDS) * fps;
    const to = t * fps;
    for (const p of players) {
      const total = countInRange(all.get(p.id)!, from, to);
      row[`h${p.id}`] =
        total === 0 ? null : Math.round((countInRange(hk.get(p.id)!, from, to) / total) * 1000) / 10;
    }
    return row;
  });

  const hotkeyGroups: Record<number, HotkeyGroup[]> = {};
  for (const p of players) {
    hotkeyGroups[p.id] = [...groups.get(p.id)!.values()]
      .filter((g) => g.assigns + g.uses > 0)
      .sort((a, b) => a.group - b.group);
  }
  return { hotkeys, hotkeyGroups };
}

/**
 * Everything the "real data" charts need for one game. Never throws for a game
 * without a dump: the hotkey series only needs the commands, so the page can
 * still show something while the re-simulation is queued.
 */
export async function gameSeries(gameId: string, viewerId: number): Promise<GameSeries | null> {
  const g = await db().query(
    "SELECT id, duration_seconds, frames, json_path, resim_status FROM games WHERE id = $1",
    [gameId]
  );
  if (!g.rowCount) return null;
  const game = g.rows[0];

  const pr = await db().query(
    "SELECT player_id, name, race, team, user_id FROM game_players WHERE game_id = $1 ORDER BY team, player_id",
    [gameId]
  );
  const players: SeriesPlayer[] = pr.rows.map((r) => ({
    id: r.player_id,
    name: r.name,
    race: r.race,
    team: r.team,
    isMe: Number(r.user_id) === viewerId,
  }));

  const durationSeconds =
    game.duration_seconds ?? Math.round((game.frames ?? 0) / FPS) ?? 0;
  const grid = gridSeconds(durationSeconds);

  let cmds: RawCmd[] = [];
  if (game.json_path) {
    try {
      const raw = JSON.parse(await fs.readFile(game.json_path, "utf8"));
      cmds = raw?.Commands?.Cmds ?? [];
    } catch {
      cmds = [];
    }
  }

  const resim = game.resim_status === "done" ? await loadResim(gameId) : null;
  const fps = resim?.header.fps ?? FPS;
  const { hotkeys, hotkeyGroups } = hotkeySeries(cmds, players, grid, fps);

  const base: GameSeries = {
    hasResim: !!resim,
    resimStatus: game.resim_status ?? "pending",
    durationSeconds,
    players,
    resources: [],
    peaks: {},
    supply: [],
    blocks: {},
    army: [],
    hotkeys,
    hotkeyGroups,
  };
  if (!resim) return base;

  // resim player index per screp PlayerID; a player missing from the dump keeps
  // its column null instead of silently reading someone else's numbers.
  const slot = new Map<number, number>();
  for (const p of players) {
    const i = resim.indexOfPlayerId(p.id);
    if (i >= 0) slot.set(p.id, i);
  }

  const resources: SeriesPoint[] = [];
  const supply: SeriesPoint[] = [];
  const army: SeriesPoint[] = [];
  for (const t of grid) {
    const i = resim.sampleAtFrame(Math.round(t * fps));
    const res: SeriesPoint = { t };
    const sup: SeriesPoint = { t };
    const arm: SeriesPoint = { t };
    if (i < 0) {
      for (const p of players) {
        res[`m${p.id}`] = null;
        res[`g${p.id}`] = null;
        sup[`u${p.id}`] = null;
        sup[`x${p.id}`] = null;
        arm[`a${p.id}`] = null;
      }
    } else {
      const workers = workersAt(resim, i);
      for (const p of players) {
        const k = slot.get(p.id);
        if (k === undefined) {
          res[`m${p.id}`] = null;
          res[`g${p.id}`] = null;
          sup[`u${p.id}`] = null;
          sup[`x${p.id}`] = null;
          arm[`a${p.id}`] = null;
          continue;
        }
        res[`m${p.id}`] = resim.minerals(i, k);
        res[`g${p.id}`] = resim.gas(i, k);
        const used = resim.supplyUsed(i, k) / 2;
        sup[`u${p.id}`] = used;
        sup[`x${p.id}`] = resim.supplyMax(i, k) / 2;
        arm[`a${p.id}`] = Math.max(0, used - workers[k]);
      }
    }
    resources.push(res);
    supply.push(sup);
    army.push(arm);
  }

  const peaks: Record<number, ResourcePeak> = {};
  const blocks: Record<number, PlayerBlocks> = {};
  for (const p of players) {
    const k = slot.get(p.id);
    if (k === undefined) {
      peaks[p.id] = { minerals: 0, mineralsSec: 0, gas: 0, gasSec: 0 };
      blocks[p.id] = { blocks: [], totalSec: 0 };
      continue;
    }
    let bm = 0;
    let bmAt = 0;
    let bg = 0;
    let bgAt = 0;
    for (let i = 0; i < resim.sampleCount; i++) {
      const m = resim.minerals(i, k);
      if (m > bm) {
        bm = m;
        bmAt = resim.frameAt(i);
      }
      const gs = resim.gas(i, k);
      if (gs > bg) {
        bg = gs;
        bgAt = resim.frameAt(i);
      }
    }
    peaks[p.id] = {
      minerals: bm,
      mineralsSec: Math.round(bmAt / fps),
      gas: bg,
      gasSec: Math.round(bgAt / fps),
    };
    blocks[p.id] = supplyBlocks(resim, k, fps);
  }

  return { ...base, resources, peaks, supply, blocks, army };
}
