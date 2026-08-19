// Recovery CLI: sets the password of an existing user.
// Usage: pnpm set-password <email> "nueva contraseña"

import bcrypt from "bcryptjs";
import { db } from "../lib/db";
import { loadEnvFile } from "./env";

loadEnvFile();

const email = process.argv[2];
const password = process.argv[3];
if (!email || !password || password.length < 8) {
  console.error('Uso: pnpm set-password <email> "contraseña de al menos 8 caracteres"');
  process.exit(1);
}

async function main() {
  const hash = bcrypt.hashSync(password, 12);
  const r = await db().query(
    "UPDATE users SET password_hash = $2 WHERE LOWER(email) = LOWER($1) RETURNING id, name",
    [email, hash]
  );
  if (!r.rowCount) {
    console.error(`No existe ningún usuario con el correo ${email}.`);
    process.exit(1);
  }
  console.log(`Contraseña actualizada para ${r.rows[0].name} <${email}>.`);
  await db().end();
}

main();
