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
 * `--tilesets` is a SEPARATE mode: it writes the *untruncated* tileset graphics
 * (cv5 / vx4ex / vx4 / vr4 / wpe) to `./data/bwtiles/`, which is what
 * `lib/map-render.ts` paints the replay-viewer terrain from. The truncation
 * above is an OpenBW quirk and would destroy these files, so they never share a
 * directory with `data/bwdata`.
 *      pnpm extract-bwdata --tilesets --sc-dir "/Applications/StarCraft"
 * The web container has no bind mount for them, so push them into the replays
 * volume afterwards (map-render looks in $REPLAYS_DIR/bwtiles too):
 *      docker compose cp ./data/bwtiles starcraft-dojo-web-1:/data/replays/bwtiles
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
const TILES_DIR = path.join(process.cwd(), "data", "bwtiles");
const FILEPATHS = path.join(process.cwd(), "resim", "vendor", "filepaths.json");

/** The eight stock tilesets, named the way the CASC/MPQ files are named. */
const TILESETS = [
  "badlands",
  "platform",
  "install",
  "ashworld",
  "jungle",
  "desert",
  "ice",
  "twilight",
];

/** vx4 only exists in pre-Remastered data; SC:R ships vx4ex (32-bit indices). */
const TILE_EXTS = ["cv5", "vx4ex", "vx4", "vr4", "wpe"];
const REQUIRED_EXTS = new Set(["cv5", "vr4", "wpe"]);

/** Flat on-disk name for a CASC path — must match `resim/lib/assets.js`. */
function flatName(fp: string): string {
  return fp.toLowerCase().replace(/[\\/]/g, "__");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface Reader {
  read(fp: string): Buffer;
  close(): void;
}

interface CascLib {
  openStorageSync(dir: string): unknown;
  readFileSync(storage: unknown, file: string): Buffer;
  closeStorage?(storage: unknown): void;
}

function cascReader(scDir: string): Reader {
  // The addon is optional and awkward to build, so an already-compiled copy can
  // be pointed at with --casclib / CASCLIB_PATH instead of installing it here.
  const candidates = [arg("casclib") ?? process.env.CASCLIB_PATH, "casclib"].filter(
    Boolean
  ) as string[];
  let loaded: unknown = null;
  for (const c of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      loaded = require(c.startsWith(".") ? path.resolve(c) : c);
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!loaded) {
    console.error(
      "casclib is not installed. It is an optional, extraction-only native addon —\n" +
        "see the header of this file for the macOS build recipe, pass --casclib\n" +
        "<path-to-a-built-copy>, or use --from-dir."
    );
    process.exit(1);
  }
  const casc = loaded as CascLib;
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

/**
 * casclib reports SC:R asset sizes 8x too large and zero-pads the rest, which is
 * why the OpenBW dump above keeps only the first eighth. Detect that padding
 * instead of assuming it, so a genuine 1.16 file read with --from-dir survives.
 */
function trimCascPadding(buf: Buffer): Buffer {
  if (buf.byteLength === 0 || buf.byteLength % 8 !== 0) return buf;
  const real = buf.byteLength / 8;
  for (let i = real; i < buf.byteLength; i++) if (buf[i] !== 0) return buf;
  return buf.subarray(0, real);
}

/**
 * Terrain graphics for the replay viewer, in their genuine 1.16 layout — these
 * are read by our own renderer (`lib/map-render.ts`), not by OpenBW.
 */
function extractTilesets(reader: Reader) {
  fs.mkdirSync(TILES_DIR, { recursive: true });
  const missing: string[] = [];
  let written = 0;
  let bytes = 0;

  for (const name of TILESETS) {
    const found: string[] = [];
    for (const ext of TILE_EXTS) {
      // CASC lookups are case-sensitive and Blizzard is not consistent about it.
      const casings = [name, name[0].toUpperCase() + name.slice(1), name.toUpperCase()];
      let raw: Buffer | null = null;
      for (const c of new Set(casings)) {
        try {
          raw = reader.read(`TileSet\\${c}.${ext}`);
          break;
        } catch {
          // next casing
        }
      }
      if (!raw) {
        if (REQUIRED_EXTS.has(ext)) missing.push(`${name}.${ext}`);
        continue;
      }
      const buf = trimCascPadding(raw);
      fs.writeFileSync(path.join(TILES_DIR, `${name}.${ext}`), buf);
      found.push(ext);
      written++;
      bytes += buf.byteLength;
    }
    if (!found.includes("vx4ex") && !found.includes("vx4")) missing.push(`${name}.vx4ex|vx4`);
    console.log(`  ${name.padEnd(9)} ${found.join(" ") || "(nothing found)"}`);
  }
  reader.close();

  console.log(`bwtiles: ${written} files (${(bytes / 1024 / 1024).toFixed(1)} MB) → ${TILES_DIR}`);
  console.log(
    "Push them into the web container's replays volume so the map-image API can read them:\n" +
      "  docker compose cp ./data/bwtiles starcraft-dojo-web-1:/data/replays/bwtiles"
  );
  if (missing.length) {
    console.error(`\nmissing: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function main() {
  const fromDir = arg("from-dir");
  const scDir = arg("sc-dir") || process.env.SC_DIR || "/Applications/StarCraft";
  const reader = fromDir ? dirReader(fromDir) : cascReader(scDir);
  if (flag("tilesets")) return extractTilesets(reader);
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
