// One-time migration to the multi-user model: crea el admin inicial, registra
// sus alias y le asigna todo el historial que hoy no tiene dueño.
//
//     pnpm db:setup && pnpm migrate:multiuser [--password "contraseña"]
//
// La contraseña sale de AUTH_PASSWORD_HASH (el hash que ya usabas) o de
// --password. Es idempotente: correrlo dos veces no duplica nada.

import bcrypt from "bcryptjs";
import { db } from "../lib/db";
import { loadEnvFile } from "./env";

loadEnvFile();

const ADMIN_EMAIL = "stephan.tinschert@gmail.com";
const ADMIN_NAME = "Stephan";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function adminHash(): string {
  const password = arg("password");
  if (password) {
    if (password.length < 8) {
      console.error("La contraseña debe tener al menos 8 caracteres.");
      process.exit(1);
    }
    return bcrypt.hashSync(password, 12);
  }
  const hash = process.env.AUTH_PASSWORD_HASH;
  if (hash) return hash;
  console.error(
    'Falta la contraseña del admin: define AUTH_PASSWORD_HASH o pasa --password "..."'
  );
  process.exit(1);
}

function aliasesFromEnv(): string[] {
  return (process.env.MY_ALIASES || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

async function main() {
  const hash = adminHash();
  const aliases = aliasesFromEnv();
  const client = await db().connect();
  try {
    await client.query("BEGIN");

    // 1. Admin inicial (el índice único es sobre LOWER(email), así que se
    //    consulta antes de insertar en vez de usar ON CONFLICT).
    const existing = await client.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [ADMIN_EMAIL]
    );
    let adminId: number;
    let created = false;
    if (existing.rowCount) {
      adminId = Number(existing.rows[0].id);
    } else {
      const r = await client.query(
        `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,'admin',$3) RETURNING id`,
        [ADMIN_EMAIL, ADMIN_NAME, hash]
      );
      adminId = Number(r.rows[0].id);
      created = true;
    }

    // 2. Alias de Battle.net.
    let aliasesAdded = 0;
    for (const alias of aliases) {
      const r = await client.query(
        `INSERT INTO player_aliases (user_id, alias)
         SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM player_aliases WHERE LOWER(alias) = LOWER($2))`,
        [adminId, alias]
      );
      aliasesAdded += r.rowCount ?? 0;
    }

    // 3. Backfill de game_players desde is_me…
    const byFlag = await client.query(
      "UPDATE game_players SET user_id = $1 WHERE is_me AND user_id IS NULL",
      [adminId]
    );
    // …y red de seguridad por nombre para filas donde is_me quedó en false.
    const byAlias = await client.query(
      `UPDATE game_players gp SET user_id = a.user_id
       FROM player_aliases a
       WHERE gp.user_id IS NULL AND LOWER(gp.name) = LOWER(a.alias)`
    );

    // 4. Todo lo privado sin dueño pasa al admin.
    const owned: Record<string, number> = {};
    for (const table of [
      "training_goals",
      "agent_notes",
      "chat_conversations",
      "game_observations",
      "game_commentary",
    ]) {
      const r = await client.query(
        `UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL`,
        [adminId]
      );
      owned[table] = r.rowCount ?? 0;
    }

    await client.query("COMMIT");

    const totals = await db().query(
      `SELECT (SELECT COUNT(*)::int FROM users) AS users,
              (SELECT COUNT(*)::int FROM player_aliases) AS aliases,
              (SELECT COUNT(*)::int FROM game_players WHERE user_id IS NOT NULL) AS linked_players,
              (SELECT COUNT(*)::int FROM v_player_games WHERE user_id = $1) AS admin_games`,
      [adminId]
    );
    const t = totals.rows[0];
    console.log(`Admin ${ADMIN_EMAIL} (id ${adminId}) ${created ? "creado" : "ya existía"}`);
    console.log(`Alias nuevos: ${aliasesAdded} (${aliases.join(", ") || "ninguno en MY_ALIASES"})`);
    console.log(`game_players vinculados: ${byFlag.rowCount} por is_me + ${byAlias.rowCount} por alias`);
    for (const [table, n] of Object.entries(owned)) console.log(`${table}: ${n} filas asignadas`);
    console.log(
      `Totales — usuarios: ${t.users} · alias: ${t.aliases} · game_players con dueño: ${t.linked_players} · partidas del admin: ${t.admin_games}`
    );
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`Migración abortada: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await db().end();
  }
}

main();
