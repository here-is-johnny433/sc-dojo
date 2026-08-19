// Server-side terrain painter: turns a replay's map tiles into a PNG the replay
// viewer draws under the units.
//
// The chain is the classic (1.16) one, and SC:R still ships every piece of it:
//
//   MTXM tile (uint16, from screp's `-maptiles` → MapData.Tiles)
//     → group = tile >> 4, subtile = tile & 0xF
//   CV5  52-byte record per group; 16 uint16 megatile ids at offset 20
//     → megatile id
//   VX4EX 16 uint32 per megatile (VX4: 16 uint16) — bit 0 is "flip horizontally",
//         the rest is the minitile id
//   VR4  64 bytes per minitile: an 8x8 block of WPE palette indices
//   WPE  256 x 4 bytes RGBA (the alpha byte is padding)
//
// One map tile is therefore 32x32 pixels. We render it as PX_PER_TILE=4 pixels,
// i.e. one output pixel per minitile, each the average of its 64 texels — the
// average keeps water/creep/high-ground edges readable where a centre sample
// would alias into noise, and makes the horizontal flip irrelevant.

import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { db } from "./db";

/** Output pixels per map tile. 128x128 tiles → 512x512 px. */
export const PX_PER_TILE = 4;

const CV5_RECORD = 52;
const CV5_MEGATILES_AT = 20;

/** screp tileset name (and a few aliases) → the file base name in BWTILES_DIR. */
const TILESET_FILES: Record<string, string> = {
  badlands: "badlands",
  "space platform": "platform",
  space: "platform",
  platform: "platform",
  installation: "install",
  install: "install",
  ashworld: "ashworld",
  jungle: "jungle",
  desert: "desert",
  arctic: "ice",
  ice: "ice",
  twilight: "twilight",
};

/** Tileset ids as screp numbers them, for maps whose name we don't recognise. */
const TILESET_BY_ID = [
  "badlands",
  "platform",
  "install",
  "ashworld",
  "jungle",
  "desert",
  "ice",
  "twilight",
];

export function tilesetFile(name: string | undefined, id?: number): string | null {
  const key = (name ?? "").trim().toLowerCase();
  if (TILESET_FILES[key]) return TILESET_FILES[key];
  if (typeof id === "number" && TILESET_BY_ID[id]) return TILESET_BY_ID[id];
  return null;
}

function tilesDir(): string[] {
  const explicit = process.env.BWTILES_DIR;
  if (explicit) return [explicit];
  const replays = process.env.REPLAYS_DIR;
  return [
    ...(replays ? [path.join(replays, "bwtiles")] : []),
    path.join(process.cwd(), "data", "bwtiles"),
  ];
}

function cacheDir(): string {
  const replays = process.env.REPLAYS_DIR || path.join(process.cwd(), "data", "replays");
  return path.join(replays, "mapimg");
}

interface Tileset {
  cv5: Buffer;
  /** 16 entries per megatile; uint32 (vx4ex) or uint16 (vx4). */
  vx4: Buffer;
  vx4Wide: boolean;
  vr4: Buffer;
  /** Flat RGB, 256*3. */
  palette: Uint8Array;
  /** Lazily filled average colour per minitile: 3 bytes each. */
  avg: Uint8Array;
  avgDone: Uint8Array;
}

/** Tileset graphics are 5-10 MB each, so only the last few stay resident. */
const loaded = new Map<string, Tileset | null>();
const MAX_RESIDENT = 2;

async function readIfThere(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/** Loads (and memoises) one tileset. Returns null when its files aren't there. */
async function loadTileset(base: string): Promise<Tileset | null> {
  const hit = loaded.get(base);
  if (hit !== undefined) return hit;

  let set: Tileset | null = null;
  for (const dir of tilesDir()) {
    const [cv5, vx4ex, vx4, vr4, wpe] = await Promise.all([
      readIfThere(path.join(dir, `${base}.cv5`)),
      readIfThere(path.join(dir, `${base}.vx4ex`)),
      readIfThere(path.join(dir, `${base}.vx4`)),
      readIfThere(path.join(dir, `${base}.vr4`)),
      readIfThere(path.join(dir, `${base}.wpe`)),
    ]);
    if (!cv5 || !vr4 || !wpe || !(vx4ex || vx4)) continue;

    // WPE is 256 RGBA entries; anything longer is trailing padding.
    const palette = new Uint8Array(256 * 3);
    for (let i = 0; i < 256 && i * 4 + 2 < wpe.length; i++) {
      palette[i * 3] = wpe[i * 4];
      palette[i * 3 + 1] = wpe[i * 4 + 1];
      palette[i * 3 + 2] = wpe[i * 4 + 2];
    }
    const minitiles = Math.floor(vr4.length / 64);
    set = {
      cv5,
      vx4: vx4ex ?? vx4!,
      vx4Wide: vx4ex != null,
      vr4,
      palette,
      avg: new Uint8Array(minitiles * 3),
      avgDone: new Uint8Array(minitiles),
    };
    break;
  }
  loaded.set(base, set);
  if (set) {
    let resident = 0;
    for (const [key, value] of [...loaded].reverse()) {
      if (!value) continue;
      if (++resident > MAX_RESIDENT) loaded.delete(key);
    }
  }
  return set;
}

/** Average colour of a minitile, computed once and kept. */
function minitileColor(ts: Tileset, id: number, out: Uint8Array, at: number): void {
  if (id >= ts.avgDone.length) {
    out[at] = 0;
    out[at + 1] = 0;
    out[at + 2] = 0;
    return;
  }
  if (!ts.avgDone[id]) {
    const off = id * 64;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < 64; i++) {
      const p = ts.vr4[off + i] * 3;
      r += ts.palette[p];
      g += ts.palette[p + 1];
      b += ts.palette[p + 2];
    }
    ts.avg[id * 3] = r >> 6;
    ts.avg[id * 3 + 1] = g >> 6;
    ts.avg[id * 3 + 2] = b >> 6;
    ts.avgDone[id] = 1;
  }
  out[at] = ts.avg[id * 3];
  out[at + 1] = ts.avg[id * 3 + 1];
  out[at + 2] = ts.avg[id * 3 + 2];
}

/**
 * Paints the terrain of one map into an RGB buffer of
 * `widthTiles*PX_PER_TILE × heightTiles*PX_PER_TILE` pixels.
 */
export async function renderTerrainRgb(
  tiles: ArrayLike<number>,
  tilesetBase: string,
  widthTiles: number,
  heightTiles: number
): Promise<{ rgb: Uint8Array; width: number; height: number } | null> {
  const ts = await loadTileset(tilesetBase);
  if (!ts) return null;
  if (tiles.length < widthTiles * heightTiles) return null;

  const W = widthTiles * PX_PER_TILE;
  const H = heightTiles * PX_PER_TILE;
  const rgb = new Uint8Array(W * H * 3);
  const groups = Math.floor(ts.cv5.length / CV5_RECORD);
  const megatiles = Math.floor(ts.vx4.length / (ts.vx4Wide ? 64 : 32));
  // How many minitiles we skip per output pixel (4 px/tile ⇒ exactly one).
  const step = 4 / PX_PER_TILE;

  for (let ty = 0; ty < heightTiles; ty++) {
    for (let tx = 0; tx < widthTiles; tx++) {
      const tile = tiles[ty * widthTiles + tx];
      const group = tile >> 4;
      const sub = tile & 0xf;
      let mega = -1;
      if (group < groups) {
        mega = ts.cv5.readUInt16LE(group * CV5_RECORD + CV5_MEGATILES_AT + sub * 2);
        if (mega >= megatiles) mega = -1;
      }
      for (let py = 0; py < PX_PER_TILE; py++) {
        const row = (ty * PX_PER_TILE + py) * W;
        for (let px = 0; px < PX_PER_TILE; px++) {
          const at = (row + tx * PX_PER_TILE + px) * 3;
          if (mega < 0) continue; // unknown group: leave it black
          const m = Math.floor(py * step) * 4 + Math.floor(px * step);
          const raw = ts.vx4Wide
            ? ts.vx4.readUInt32LE(mega * 64 + m * 4)
            : ts.vx4.readUInt16LE(mega * 32 + m * 2);
          minitileColor(ts, raw >>> 1, rgb, at); // bit 0 is the horizontal flip
        }
      }
    }
  }
  return { rgb, width: W, height: H };
}

// --- Minimal PNG encoder (8-bit truecolour, no dependencies) ---

let crcTable: Int32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  // Filter type 1 (Sub) per scanline: terrain is mostly locally flat, so this
  // roughly halves the deflated size over the "no filter" encoding.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 1;
    const src = y * stride;
    for (let x = 0; x < stride; x++) {
      raw[at + 1 + x] = (rgb[src + x] - (x >= 3 ? rgb[src + x - 3] : 0)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 8 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface TileJson {
  Header?: { MapWidth?: number; MapHeight?: number };
  MapData?: { TileSet?: { Name?: string; ID?: number }; Tiles?: number[] };
}

/**
 * The terrain PNG for a game, cached on disk. Returns null — never throws —
 * when the replay was parsed without `-maptiles` or the tileset files are
 * missing, so the viewer just keeps its flat background.
 */
export async function mapImage(gameId: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{16}$/.test(gameId)) return null;
  const cached = path.join(cacheDir(), `${gameId}.png`);
  const hit = await readIfThere(cached);
  if (hit && hit.length > 0) return hit;

  const g = await db().query("SELECT json_path FROM games WHERE id = $1", [gameId]);
  const jsonPath = g.rows[0]?.json_path;
  if (!jsonPath) return null;

  let raw: TileJson;
  try {
    raw = JSON.parse(await fs.readFile(jsonPath, "utf8")) as TileJson;
  } catch {
    return null;
  }
  const tiles = raw.MapData?.Tiles;
  const w = raw.Header?.MapWidth ?? 0;
  const h = raw.Header?.MapHeight ?? 0;
  if (!Array.isArray(tiles) || !w || !h) return null;
  const base = tilesetFile(raw.MapData?.TileSet?.Name, raw.MapData?.TileSet?.ID);
  if (!base) return null;

  const painted = await renderTerrainRgb(tiles, base, w, h);
  if (!painted) return null;
  const png = encodePng(painted.rgb, painted.width, painted.height);

  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    const tmp = `${cached}.${process.pid}.tmp`;
    await fs.writeFile(tmp, png);
    await fs.rename(tmp, cached);
  } catch {
    // a read-only or full volume must not break the response
  }
  return png;
}
