"use strict";
/**
 * Capa B — OpenBW re-simulation worker.
 *
 * Every POLL_INTERVAL_MS it claims one `games` row with resim_status='pending'
 * (FOR UPDATE SKIP LOCKED, so several workers can share the queue), re-simulates
 * the replay with OpenBW and writes /data/replays/resim/<gameId>.bin.gz. The row
 * ends as 'done', 'skipped' (practice games / any Computer player: OpenBW has no
 * ComputerAI) or 'failed' with resim_error.
 */
const path = require("path");
const { spawn } = require("child_process");
const { Pool } = require("pg");

const POLL_INTERVAL_MS = Number(process.env.RESIM_POLL_MS || 15_000);
const GAME_TIMEOUT_MS = Number(process.env.RESIM_TIMEOUT_MS || 120_000);
const REPLAYS_DIR = process.env.REPLAYS_DIR || "/data/replays";
const RESULT_PREFIX = "__RESIM__";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Claims one pending game and flips it to 'running' in the same transaction. */
async function claimGame() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, rep_path, is_practice, frames, map_name
         FROM games
        WHERE resim_status = 'pending'
        ORDER BY played_at DESC NULLS LAST
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    );
    if (!rows.length) {
      await client.query("COMMIT");
      return null;
    }
    const game = rows[0];
    await client.query("UPDATE games SET resim_status = 'running', resim_error = NULL WHERE id = $1", [
      game.id,
    ]);
    await client.query("COMMIT");

    const players = await pool.query(
      `SELECT player_id AS id, name, is_computer
         FROM game_players WHERE game_id = $1 ORDER BY player_id`,
      [game.id]
    );
    game.players = players.rows;
    return game;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function finish(gameId, status, error) {
  await pool.query("UPDATE games SET resim_status = $2, resim_error = $3 WHERE id = $1", [
    gameId,
    status,
    error ? String(error).slice(0, 2000) : null,
  ]);
}

/** Runs run-one.js in a child process with a hard timeout. */
function runChild(job) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "run-one.js"), JSON.stringify(job)], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GAME_TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d.toString().slice(0, 4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn failed: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        return resolve({ ok: false, error: `timed out after ${GAME_TIMEOUT_MS / 1000}s` });
      }
      const line = out.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
      if (line) {
        try {
          return resolve(JSON.parse(line.slice(RESULT_PREFIX.length)));
        } catch {
          /* fall through */
        }
      }
      resolve({
        ok: false,
        error: `child exited code=${code} signal=${signal}${err ? ": " + err.trim().split("\n").pop() : ""}`,
      });
    });
  });
}

async function processGame(game) {
  if (game.is_practice || game.players.some((p) => p.is_computer)) {
    await finish(game.id, "skipped", null);
    log(`skip  ${game.id} (practice / computer player)`);
    return;
  }
  if (!game.rep_path) {
    await finish(game.id, "failed", "no rep_path on the games row");
    return;
  }

  const outPath = path.join(REPLAYS_DIR, "resim", `${game.id}.bin.gz`);
  const t0 = Date.now();
  const res = await runChild({
    gameId: game.id,
    repPath: game.rep_path,
    outPath,
    players: game.players.map((p) => ({ id: p.id, name: p.name })),
  });

  if (res.ok) {
    const s = res.stats;
    await finish(game.id, "done", null);
    log(
      `done  ${game.id} ${game.map_name || ""} frames=${s.frames} samples=${s.sampleCount} ` +
        `types=${s.types} gz=${(s.gzBytes / 1024 / 1024).toFixed(2)}MB in ${Date.now() - t0}ms` +
        (s.unmatchedPlayers.length ? ` (unmatched: ${s.unmatchedPlayers.join(",")})` : "")
    );
  } else if (res.skip) {
    await finish(game.id, "skipped", res.error);
    log(`skip  ${game.id}: ${res.error}`);
  } else {
    await finish(game.id, "failed", res.error);
    log(`FAIL  ${game.id}: ${res.error}`);
  }
}

let stopping = false;

async function loop() {
  while (!stopping) {
    let worked = false;
    try {
      const game = await claimGame();
      if (game) {
        worked = true;
        await processGame(game);
      }
    } catch (e) {
      log("loop error:", e.message);
    }
    // Drain the queue back to back; only idle when there is nothing to do.
    if (!worked && !stopping) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  await pool.end();
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} — finishing current game and exiting`);
    stopping = true;
  });
}

/** A container killed mid-game leaves rows in 'running'; re-queue them at boot. */
async function requeueStale() {
  for (let attempt = 1; ; attempt++) {
    try {
      const { rowCount } = await pool.query(
        "UPDATE games SET resim_status = 'pending' WHERE resim_status = 'running'"
      );
      if (rowCount) log(`re-queued ${rowCount} game(s) left in 'running'`);
      return;
    } catch (e) {
      if (attempt >= 20) throw e;
      log(`waiting for the database (${e.message})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

log(`resim worker up — poll ${POLL_INTERVAL_MS}ms, timeout ${GAME_TIMEOUT_MS}ms, out ${REPLAYS_DIR}/resim`);
requeueStale()
  .then(loop)
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
