// Bulk-imports .rep files into the platform via the upload API.
// Usage: pnpm ingest [dir] [--url http://localhost:3000] [--source autosave-mac]
// Reads UPLOAD_TOKEN from .env.

import fs from "fs";
import path from "path";
import os from "os";

const DEFAULT_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Blizzard/StarCraft/Maps/Replays"
);

function parseEnv(): Record<string, string> {
  const envPath = path.join(process.cwd(), ".env");
  const out: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=['"]?(.*?)['"]?$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function findReps(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findReps(full));
    else if (entry.name.toLowerCase().endsWith(".rep")) results.push(full);
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf("--url");
  const srcIdx = args.indexOf("--source");
  const url = urlIdx >= 0 ? args[urlIdx + 1] : "http://localhost:3000";
  const source = srcIdx >= 0 ? args[srcIdx + 1] : "autosave-mac";
  const dir = args.find((a) => !a.startsWith("--") && a !== url && a !== source) || DEFAULT_DIR;

  const token = process.env.UPLOAD_TOKEN || parseEnv().UPLOAD_TOKEN;
  if (!token) {
    console.error("UPLOAD_TOKEN no encontrado (.env)");
    process.exit(1);
  }

  const files = findReps(dir);
  console.log(`Encontrados ${files.length} replays en ${dir}`);

  let imported = 0, duplicates = 0, errors = 0;
  for (const file of files) {
    const buf = fs.readFileSync(file);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)]), path.basename(file));
    form.append("source", source);
    try {
      const res = await fetch(`${url}/api/upload`, {
        method: "POST",
        headers: { "x-upload-token": token },
        body: form,
      });
      const body = (await res.json()) as { status?: string; detail?: string };
      if (body.status === "imported") {
        imported++;
        console.log(`✓ ${path.basename(file)}`);
      } else if (body.status === "duplicate") {
        duplicates++;
      } else {
        errors++;
        console.error(`✗ ${path.basename(file)}: ${body.detail ?? res.status}`);
      }
    } catch (e) {
      errors++;
      console.error(`✗ ${path.basename(file)}: ${(e as Error).message}`);
    }
  }
  console.log(`\nImportados: ${imported} · Duplicados: ${duplicates} · Errores: ${errors}`);
}

main();
