#!/usr/bin/env tsx
/**
 * Re-parses every already-ingested replay so its stored screp JSON carries
 * `MapData.Tiles` — the terrain the replay viewer paints (see lib/map-render.ts).
 * Replays ingested before `-maptiles` was added to lib/screp.ts have none.
 *
 *     pnpm reparse-maps            # every game
 *     pnpm reparse-maps --force    # also rewrite the ones that already have tiles
 *     pnpm reparse-maps --game <id>
 *
 * Why it drives Docker instead of doing the work itself: the .rep files and the
 * parsed JSON live in the `replays` volume, which is only mounted inside the web
 * container, and that container already ships the exact screp build that
 * produced them. So the loop is `docker compose exec web screp … > …` — nothing
 * is copied through the host, each file is rewritten atomically via /tmp, and
 * running this from a host without screp (or without the replays) works fine.
 * The container has no tsx, hence the driver lives here.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const WEB = process.env.WEB_SERVICE || "web";
const DB = process.env.DB_SERVICE || "db";
const PGUSER = process.env.PGUSER || "dojo";
const PGDATABASE = process.env.PGDATABASE || "starcraft_dojo";
const SCREP = "/usr/local/bin/screp";
const REPS = "/data/replays/reps";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function compose(args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["compose", ...args], {
    maxBuffer,
    timeout: 120_000,
  });
  return stdout;
}

/** `docker compose exec -T <svc> sh -c "<script>"` */
function sh(service: string, script: string): Promise<string> {
  return compose(["exec", "-T", service, "sh", "-c", script]);
}

interface Row {
  id: string;
  jsonPath: string;
}

async function games(): Promise<Row[]> {
  const out = await compose([
    "exec",
    "-T",
    DB,
    "psql",
    "-U",
    PGUSER,
    "-d",
    PGDATABASE,
    "-t",
    "-A",
    "-F",
    "\t",
    "-c",
    "SELECT id, json_path FROM games WHERE json_path IS NOT NULL ORDER BY id",
  ]);
  const rows: Row[] = [];
  for (const line of out.split("\n")) {
    const [id, jsonPath] = line.trim().split("\t");
    if (!id || !jsonPath) continue;
    // Both go into a shell command below, so nothing exotic is allowed through.
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error(`unexpected game id: ${id}`);
    if (!/^[\w./-]+$/.test(jsonPath)) throw new Error(`unexpected json_path: ${jsonPath}`);
    rows.push({ id, jsonPath });
  }
  return rows;
}

/** ids whose stored JSON already has a non-empty MapData.Tiles. */
async function withTiles(): Promise<Set<string>> {
  const script = `
const fs = require('fs');
const dir = '/data/replays/parsed';
const out = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'));
    const t = j.MapData && j.MapData.Tiles;
    if (Array.isArray(t) && t.length > 0) out.push(f.slice(0, -5) + ':' + t.length);
  } catch {}
}
console.log(out.join(' '));
`.trim();
  const out = await compose([
    "exec",
    "-T",
    WEB,
    "node",
    "-e",
    script,
  ]);
  return new Set(
    out
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.split(":")[0])
  );
}

async function main() {
  const only = arg("game");
  const force = process.argv.includes("--force");

  let rows = await games();
  if (only) rows = rows.filter((r) => r.id === only);
  if (rows.length === 0) {
    console.error("no games to re-parse");
    process.exit(1);
  }

  const already = force ? new Set<string>() : await withTiles();
  console.log(
    `${rows.length} game(s); ${already.size} already carry tiles${force ? " (--force: rewriting all)" : ""}`
  );

  let done = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const r of rows) {
    if (already.has(r.id)) {
      skipped++;
      continue;
    }
    const tmp = `/tmp/reparse-${r.id}.json`;
    try {
      await sh(
        WEB,
        `set -e; ${SCREP} -cmds -map -mapres -maptiles -indent=false ${REPS}/${r.id}.rep > ${tmp}; ` +
          `test -s ${tmp}; mv ${tmp} ${r.jsonPath}`
      );
      done++;
      process.stdout.write(`  ✓ ${r.id}\n`);
    } catch (e) {
      failed.push(`${r.id}: ${(e as Error).message.split("\n")[0]}`);
      await sh(WEB, `rm -f ${tmp}`).catch(() => {});
      process.stdout.write(`  ✗ ${r.id}\n`);
    }
  }

  const verified = await withTiles();
  const covered = rows.filter((r) => verified.has(r.id)).length;
  console.log(
    `\nre-parsed ${done}, skipped ${skipped}, failed ${failed.length} — ` +
      `${covered}/${rows.length} JSON files now carry MapData.Tiles`
  );
  for (const f of failed) console.error("  " + f);
  if (failed.length || covered < rows.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
