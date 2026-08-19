// Regenera las observaciones (y las evaluaciones del objetivo activo) de un
// usuario a partir del JSON guardado de sus partidas. Útil tras vincular un
// alias a partidas ya ingeridas desde el módulo admin.
//
//     pnpm reprocess-observations <email>

import fs from "fs/promises";
import { db } from "../lib/db";
import { analyzePlayer, persistPlayerAnalysis, replayEvents } from "../lib/ingest";
import type { ScrepResult } from "../lib/screp";
import { loadEnvFile } from "./env";

loadEnvFile();

const email = process.argv[2];
if (!email) {
  console.error("Uso: pnpm reprocess-observations <email>");
  process.exit(1);
}

async function main() {
  const u = await db().query("SELECT id, name FROM users WHERE LOWER(email) = LOWER($1)", [email]);
  if (!u.rowCount) {
    console.error(`No existe ningún usuario con el correo ${email}.`);
    process.exit(1);
  }
  const userId = Number(u.rows[0].id);

  const games = await db().query(
    `SELECT g.id, g.json_path, gp.player_id
     FROM games g JOIN game_players gp ON gp.game_id = g.id
     WHERE gp.user_id = $1 AND g.json_path IS NOT NULL
     ORDER BY g.played_at`,
    [userId]
  );

  let done = 0;
  let skipped = 0;
  for (const row of games.rows) {
    let rep: ScrepResult;
    try {
      rep = JSON.parse(await fs.readFile(row.json_path, "utf8")) as ScrepResult;
    } catch (e) {
      skipped++;
      console.error(`✗ ${row.id}: no se pudo leer ${row.json_path} (${(e as Error).message})`);
      continue;
    }
    const { events, hotkeyPct, durationSeconds } = replayEvents(rep);
    const analysis = analyzePlayer(row.player_id, events, hotkeyPct(row.player_id), durationSeconds);

    const client = await db().connect();
    try {
      await client.query("BEGIN");
      await persistPlayerAnalysis(client, row.id, userId, analysis);
      await client.query("COMMIT");
      done++;
      console.log(`✓ ${row.id}: ${analysis.observations.length} observaciones`);
    } catch (e) {
      await client.query("ROLLBACK");
      skipped++;
      console.error(`✗ ${row.id}: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log(`\n${u.rows[0].name}: ${done} partidas regeneradas · ${skipped} omitidas`);
  await db().end();
}

main();
