// Scripts run outside Next.js, which is what loads .env for the app. Real
// environment variables always win over the file.

import fs from "fs";
import path from "path";

export function loadEnvFile(): void {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=['"]?(.*?)['"]?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
