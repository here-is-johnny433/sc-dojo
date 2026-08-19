// Backfill / refresh del espectro de rendimiento (player_scores).
// Usage: pnpm scores [--force]
//   default: scores games with no rows yet, and re-scores games whose
//            re-simulation finished after they were scored without it.
//   --force: recompute every game (run after tuning the curves in lib/scores.ts).

import { db } from "../lib/db";
import { computePlayerScores } from "../lib/scores";

async function main() {
  const force = process.argv.includes("--force");
  const r = force
    ? await db().query(`SELECT id FROM games ORDER BY played_at ASC NULLS LAST`)
    : await db().query(`
        SELECT g.id FROM games g
        LEFT JOIN player_scores s ON s.game_id = g.id
        GROUP BY g.id
        HAVING COUNT(s.game_id) = 0
            OR (g.resim_status = 'done' AND BOOL_OR(NOT s.with_resim))
        ORDER BY MAX(g.played_at) ASC NULLS LAST`);

  console.log(`${r.rowCount} partidas por puntuar${force ? " (force)" : ""}`);
  let done = 0;
  let failed = 0;
  for (const row of r.rows) {
    try {
      const scores = await computePlayerScores(row.id);
      done++;
      const mine = scores.find((s) => s.overall != null);
      console.log(`✓ ${row.id}${mine ? ` (overall ${mine.overall})` : ""}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${row.id}: ${(e as Error).message}`);
    }
  }
  console.log(`\nPuntuadas: ${done} · Errores: ${failed}`);
  process.exit(failed ? 1 : 0);
}

main();
