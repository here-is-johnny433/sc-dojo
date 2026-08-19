#!/usr/bin/env tsx
/**
 * Extracts the StarCraft: Remastered game data files that OpenBW needs into
 * `./data/bwdata/`, so the re-simulation worker (capa B) can run without any
 * StarCraft installation inside Docker.
 *
 * ⚠️  LICENSE: the extracted files are Blizzard property. `data/` is gitignored
 * and is never copied into any Docker image — it is bind-mounted read-only at
 * runtime. Do NOT redistribute them.
 *
 * Two sources:
 *   1. A local SC:R install (CASC storage) — needs the optional `casclib` addon.
 *        pnpm extract-bwdata --sc-dir "/Applications/StarCraft"
 *   2. A directory that already holds the raw files, flat-named the same way
 *      this script names them (useful to re-truncate an old dump):
 *        pnpm extract-bwdata --from-dir /path/to/raw-dump
 *
 * Every file is truncated to its first `byteLength / 8` bytes: the SC:R CASC
 * assets are 8x the size OpenBW's 1.16 parser expects (this is exactly what
 * titan-reactor's `OpenBWFileList.loadBuffers` does). Without it OpenBW aborts
 * with `flingy.dat: 21945 bytes left (incorrect version?)`.
 *
 * Installing casclib on macOS (clang rejects its vendored libtomcrypt):
 *   npm i casclib@1.0.4 --ignore-scripts
 *   # add to the CascLibRAS target in node_modules/casclib/binding.gyp:
 *   #   'cflags': ['-Wno-implicit-function-declaration','-Wno-int-conversion'],
 *   #   'xcode_settings': { 'OTHER_CFLAGS': ['-Wno-implicit-function-declaration',
 *   #     '-Wno-int-conversion','-Wno-error'], 'MACOSX_DEPLOYMENT_TARGET':'10.13' }
 *   cd node_modules/casclib && npx node-gyp rebuild
 */
import fs from "fs";
import path from "path";

const OUT_DIR = path.join(process.cwd(), "data", "bwdata");
const FILEPATHS = path.join(process.cwd(), "resim", "vendor", "filepaths.json");

/** Flat on-disk name for a CASC path — must match `resim/lib/assets.js`. */
function flatName(fp: string): string {
  return fp.toLowerCase().replace(/[\\/]/g, "__");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface Reader {
  read(fp: string): Buffer;
  close(): void;
}

function cascReader(scDir: string): Reader {
  let casc: {
    openStorageSync(dir: string): unknown;
    readFileSync(storage: unknown, file: string): Buffer;
    closeStorage?(storage: unknown): void;
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    casc = require("casclib");
  } catch {
    console.error(
      "casclib is not installed. It is an optional, extraction-only native addon —\n" +
        "see the header of this file for the macOS build recipe, or use --from-dir."
    );
    process.exit(1);
  }
  const storage = casc.openStorageSync(scDir);
  return {
    read: (fp) => casc.readFileSync(storage, fp.replace(/\\/g, "/")),
    close: () => casc.closeStorage?.(storage),
  };
}

function dirReader(dir: string): Reader {
  return {
    read(fp) {
      for (const candidate of [flatName(fp), fp.replace(/[\\/]/g, "__"), fp]) {
        const p = path.join(dir, candidate);
        if (fs.existsSync(p)) return fs.readFileSync(p);
      }
      throw new Error(`not found in ${dir}`);
    },
    close: () => {},
  };
}

function main() {
  const fromDir = arg("from-dir");
  const scDir = arg("sc-dir") || process.env.SC_DIR || "/Applications/StarCraft";
  const reader = fromDir ? dirReader(fromDir) : cascReader(scDir);
  const filepaths: string[] = JSON.parse(fs.readFileSync(FILEPATHS, "utf8"));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let written = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const fp of filepaths) {
    const name = flatName(fp);
    if (seen.has(name)) continue;
    seen.add(name);
    let buf: Buffer;
    try {
      buf = reader.read(fp);
    } catch (e) {
      failed.push(`${fp}: ${(e as Error).message}`);
      continue;
    }
    // See the header comment: OpenBW's 1.16 parser wants the first 1/8 only.
    const truncated = buf.subarray(0, Math.floor(buf.byteLength / 8));
    fs.writeFileSync(path.join(OUT_DIR, name), truncated);
    written++;
    bytesIn += buf.byteLength;
    bytesOut += truncated.byteLength;
  }
  reader.close();

  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      { version: 1, files: written, truncatedToEighth: true, generatedAt: new Date().toISOString() },
      null,
      2
    )
  );

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + " MB";
  console.log(`bwdata: ${written} files → ${OUT_DIR}`);
  console.log(`        ${mb(bytesIn)} raw → ${mb(bytesOut)} truncated`);
  if (failed.length) {
    console.error(`\n${failed.length} file(s) could not be read:`);
    for (const f of failed.slice(0, 20)) console.error("  " + f);
    process.exit(1);
  }
}

main();
