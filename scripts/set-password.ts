// Generates a bcrypt hash for AUTH_PASSWORD_HASH and updates .env.
// Usage: pnpm set-password "mi-nueva-contraseña"

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error("Uso: pnpm set-password \"contraseña de al menos 8 caracteres\"");
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const env = fs.readFileSync(envPath, "utf8");
  const line = `AUTH_PASSWORD_HASH='${hash}'`;
  const updated = env.match(/^AUTH_PASSWORD_HASH=/m)
    ? env.replace(/^AUTH_PASSWORD_HASH=.*$/m, line)
    : env + "\n" + line + "\n";
  fs.writeFileSync(envPath, updated);
  console.log(".env actualizado. Reinicia la app (docker compose restart web).");
} else {
  console.log(`AUTH_PASSWORD_HASH='${hash}'`);
}
