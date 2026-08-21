// Reader for the "layer B" re-simulation dumps (OpenBW). The worker writes one
// gzipped file per game; this module parses the *decompressed* buffer and is
// shared by the server (API route, coach tools) and the browser (replay viewer).
//
// Wire format — little-endian:
//   "DJR1" | uint32 headerLen | headerLen bytes of UTF-8 JSON | payload
// payload, per sample:
//   uint32 frame
//   per player (header order): uint16 minerals, gas, supplyUsed, supplyMax
//                              (supply is in HALF units — divide by 2 to show)
//   uint16 unitCount
//   unitCount × 10 bytes: uint16 tag, uint16 typeId, uint8 ownerIdx,
//                         uint16 x, uint16 y (pixels), uint8 hpPct
//
// Nothing is expanded into JS objects: samples are addressed by precomputed
// byte offsets and read straight out of the DataView while drawing.

export const RESIM_MAGIC = "DJR1";
export const UNIT_BYTES = 10;
const ECO_BYTES = 8; // minerals, gas, supplyUsed, supplyMax

export interface ResimTypeInfo {
  name: string;
  building: boolean;
  /** 0 small · 1 medium · 2 large — drives the dot radius on the board. */
  size: number;
}

export interface ResimHeader {
  version: number;
  gameId: string;
  frames: number;
  fps: number;
  sampleStep: number;
  sampleCount: number;
  /** `id` is the screp PlayerID, so it joins the viewer-data players directly. */
  players: { id: number; name: string }[];
  types: Record<string, ResimTypeInfo>;
}

export interface ResimDeath {
  tag: number;
  typeId: number;
  ownerIdx: number;
  /** Last known position, i.e. where the unit was on the previous sample. */
  x: number;
  y: number;
  frame: number;
}

/** Flat, frame-sorted death index with per-owner running totals. */
export interface DeathIndex {
  count: number;
  frame: Int32Array;
  x: Uint16Array;
  y: Uint16Array;
  owner: Uint8Array;
  type: Uint16Array;
  /** cum[i * players + p] = deaths of player p strictly before index i. */
  cum: Int32Array;
  players: number;
}

const UNKNOWN_TYPE: ResimTypeInfo = { name: "?", building: false, size: 0 };

/** How close a newborn unit must be to a vanished one to read as a morph. */
const MORPH_RADIUS_PX = 40;

const PSEUDO_RE = /turret|scanner sweep|dark swarm|disruption web|map revealer|start location|flag|spell|nuclear missile/i;
const EPHEMERAL_RE = /larva|egg|cocoon|scarab/i;
const WORKER_RE = /(^|\s)(probe|scv|drone)$/i;

/**
 * Sub-units and spell effects OpenBW reports as units: tank/goliath turrets ride
 * on their parent, a scan is not a unit. They must not be drawn or counted.
 * (Terran Missile Turret is a *building*, hence the guard.)
 */
export function isPseudoType(info: ResimTypeInfo): boolean {
  return !info.building && PSEUDO_RE.test(info.name);
}

/** Real objects, but their disappearance is a morph or a spent shot — not a loss. */
export function isEphemeralType(info: ResimTypeInfo): boolean {
  return EPHEMERAL_RE.test(info.name);
}

export function isWorkerType(info: ResimTypeInfo): boolean {
  return !info.building && WORKER_RE.test(info.name);
}

/** 0 = bio (orgánico terrestre) · 1 = mech (mecánico terrestre) · 2 = aire. */
export type UnitClass = 0 | 1 | 2;

const AIR_RE =
  /wraith|dropship|battlecruiser|valkyrie|science vessel|scout|corsair|carrier|interceptor|arbiter|shuttle|observer|overlord|mutalisk|scourge|guardian|devourer|queen/i;
const MECH_RE = /scv|probe|vulture|siege tank|goliath|dragoon|reaver/i;

/**
 * Shape class of a mobile unit on the replay board: air flies as a triangle,
 * ground mech rolls as a square, everything organic walks as a circle.
 */
export function unitClass(info: ResimTypeInfo): UnitClass {
  if (AIR_RE.test(info.name)) return 2;
  if (MECH_RE.test(info.name)) return 1;
  return 0;
}

/** "Protoss Dark Templar" → "Dark Templar". */
export function shortUnitName(name: string): string {
  return name.replace(/^(Terran|Protoss|Zerg|Hero|Special) /, "");
}

export class Resim {
  readonly header: ResimHeader;
  readonly playerCount: number;
  readonly sampleCount: number;
  private readonly view: DataView;
  /** Byte offset of every sample record. */
  private readonly off: Int32Array;
  private readonly unitsAt: number; // bytes from a sample start to its first unit
  private deaths: DeathIndex | null = null;

  constructor(header: ResimHeader, view: DataView, off: Int32Array) {
    this.header = header;
    this.playerCount = header.players.length;
    this.sampleCount = off.length;
    this.view = view;
    this.off = off;
    this.unitsAt = 4 + this.playerCount * ECO_BYTES + 2;
  }

  frameAt(i: number): number {
    return this.view.getUint32(this.off[i], true);
  }

  minerals(i: number, p: number): number {
    return this.view.getUint16(this.off[i] + 4 + p * ECO_BYTES, true);
  }
  gas(i: number, p: number): number {
    return this.view.getUint16(this.off[i] + 4 + p * ECO_BYTES + 2, true);
  }
  /** In half units — divide by 2 for the in-game number. */
  supplyUsed(i: number, p: number): number {
    return this.view.getUint16(this.off[i] + 4 + p * ECO_BYTES + 4, true);
  }
  supplyMax(i: number, p: number): number {
    return this.view.getUint16(this.off[i] + 4 + p * ECO_BYTES + 6, true);
  }

  unitCount(i: number): number {
    return this.view.getUint16(this.off[i] + this.unitsAt - 2, true);
  }

  private unitBase(i: number, k: number): number {
    return this.off[i] + this.unitsAt + k * UNIT_BYTES;
  }
  unitTag(i: number, k: number): number {
    return this.view.getUint16(this.unitBase(i, k), true);
  }
  unitType(i: number, k: number): number {
    return this.view.getUint16(this.unitBase(i, k) + 2, true);
  }
  unitOwner(i: number, k: number): number {
    return this.view.getUint8(this.unitBase(i, k) + 4);
  }
  unitX(i: number, k: number): number {
    return this.view.getUint16(this.unitBase(i, k) + 5, true);
  }
  unitY(i: number, k: number): number {
    return this.view.getUint16(this.unitBase(i, k) + 7, true);
  }
  unitHp(i: number, k: number): number {
    return this.view.getUint8(this.unitBase(i, k) + 9);
  }

  typeInfo(typeId: number): ResimTypeInfo {
    return this.header.types[String(typeId)] ?? UNKNOWN_TYPE;
  }
  typeName(typeId: number): string {
    return this.typeInfo(typeId).name;
  }
  playerName(ownerIdx: number): string {
    return this.header.players[ownerIdx]?.name ?? `#${ownerIdx}`;
  }
  /** Index into header.players for a screp PlayerID, or -1. */
  indexOfPlayerId(playerId: number): number {
    return this.header.players.findIndex((p) => p.id === playerId);
  }

  /** Last sample at or before `frame` (0 when the frame precedes the first). */
  sampleAtFrame(frame: number): number {
    if (this.sampleCount === 0) return -1;
    let lo = 0;
    let hi = this.sampleCount - 1;
    if (frame <= this.frameAt(0)) return 0;
    if (frame >= this.frameAt(hi)) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.frameAt(mid) <= frame) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Tag → typeId*256+ownerIdx for one sample, so recycled tags are detectable. */
  private identityMap(i: number, into: Map<number, number>): Map<number, number> {
    into.clear();
    const n = this.unitCount(i);
    for (let k = 0; k < n; k++) {
      into.set(this.unitTag(i, k), this.unitType(i, k) * 256 + this.unitOwner(i, k));
    }
    return into;
  }

  /**
   * Real deaths between sample i-1 and i, written into `sink`.
   *
   * Three kinds of disappearance are NOT deaths and get filtered here, because
   * every consumer (board flashes, loss counters, battle report) would other-
   * wise drown in them:
   *   · pseudo units (turrets, scans) — never existed as units;
   *   · larvae, eggs, cocoons, scarabs — morph plumbing and spent shots;
   *   · morphs proper: something of the same owner is born on the spot the
   *     vanished unit occupied (drone → building, hydra → lurker, hatch → lair,
   *     and a recycled tag reappearing as another unit).
   */
  private collectDeaths(
    i: number,
    prev: Map<number, number>,
    cur: Map<number, number>,
    sink: (d: ResimDeath) => void
  ): void {
    const frame = this.frameAt(i);
    // Newborns of this sample, so a morph can be told from a kill.
    const bx: number[] = [];
    const by: number[] = [];
    const bOwner: number[] = [];
    const stillAlive = new Int32Array(this.playerCount);
    const born = this.unitCount(i);
    for (let k = 0; k < born; k++) {
      const owner = this.unitOwner(i, k);
      if (owner < this.playerCount) stillAlive[owner]++;
      const tag = this.unitTag(i, k);
      if (prev.get(tag) === this.unitType(i, k) * 256 + owner) continue;
      bx.push(this.unitX(i, k));
      by.push(this.unitY(i, k));
      bOwner.push(owner);
    }

    const n = this.unitCount(i - 1);
    for (let k = 0; k < n; k++) {
      const tag = this.unitTag(i - 1, k);
      const typeId = this.unitType(i - 1, k);
      const ownerIdx = this.unitOwner(i - 1, k);
      if (cur.get(tag) === typeId * 256 + ownerIdx) continue;
      // Everything a player owned vanishing at once is them leaving the game,
      // not a fight — otherwise every replay ends in a fake 30-kill battle.
      if (ownerIdx < this.playerCount && stillAlive[ownerIdx] === 0) continue;
      const info = this.typeInfo(typeId);
      if (isPseudoType(info) || isEphemeralType(info)) continue;
      const x = this.unitX(i - 1, k);
      const y = this.unitY(i - 1, k);
      let morphed = false;
      for (let b = 0; b < bx.length; b++) {
        if (bOwner[b] !== ownerIdx) continue;
        if (Math.abs(bx[b] - x) <= MORPH_RADIUS_PX && Math.abs(by[b] - y) <= MORPH_RADIUS_PX) {
          morphed = true;
          break;
        }
      }
      if (!morphed) sink({ tag, typeId, ownerIdx, x, y, frame });
    }
  }

  /** Real deaths between sample i-1 and i. */
  diffDeaths(i: number): ResimDeath[] {
    if (i <= 0 || i >= this.sampleCount) return [];
    const out: ResimDeath[] = [];
    this.collectDeaths(
      i,
      this.identityMap(i - 1, new Map()),
      this.identityMap(i, new Map()),
      (d) => out.push(d)
    );
    return out;
  }

  /**
   * Every death in the game, frame-sorted, in typed arrays — built once and
   * cached. Rendering and the sidebar counters read it, never diffDeaths().
   */
  deathIndex(): DeathIndex {
    if (this.deaths) return this.deaths;
    const frames: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const owners: number[] = [];
    const types: number[] = [];

    let prev = new Map<number, number>();
    let cur = new Map<number, number>();
    if (this.sampleCount > 0) this.identityMap(0, prev);
    for (let i = 1; i < this.sampleCount; i++) {
      this.identityMap(i, cur);
      this.collectDeaths(i, prev, cur, (d) => {
        frames.push(d.frame);
        xs.push(d.x);
        ys.push(d.y);
        owners.push(d.ownerIdx);
        types.push(d.typeId);
      });
      const swap = prev;
      prev = cur;
      cur = swap;
    }

    const count = frames.length;
    const P = Math.max(1, this.playerCount);
    const cum = new Int32Array((count + 1) * P);
    for (let i = 0; i < count; i++) {
      for (let p = 0; p < P; p++) cum[(i + 1) * P + p] = cum[i * P + p];
      const o = owners[i];
      if (o < P) cum[(i + 1) * P + o]++;
    }
    this.deaths = {
      count,
      frame: Int32Array.from(frames),
      x: Uint16Array.from(xs),
      y: Uint16Array.from(ys),
      owner: Uint8Array.from(owners),
      type: Uint16Array.from(types),
      cum,
      players: P,
    };
    return this.deaths;
  }
}

/** First index in the death index whose frame is >= `frame`. */
export function deathLowerBound(d: DeathIndex, frame: number): number {
  let lo = 0;
  let hi = d.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d.frame[mid] < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Losses of player `ownerIdx` up to and including `frame`. */
export function deathsUpTo(d: DeathIndex, ownerIdx: number, frame: number): number {
  const i = deathLowerBound(d, frame + 1);
  return d.cum[i * d.players + ownerIdx] ?? 0;
}

export function parseResim(buf: ArrayBuffer): Resim {
  if (buf.byteLength < 8) throw new Error("archivo de re-simulación truncado");
  const view = new DataView(buf);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== RESIM_MAGIC) throw new Error(`magic inesperado: ${JSON.stringify(magic)}`);

  const headerLen = view.getUint32(4, true);
  if (8 + headerLen > buf.byteLength) throw new Error("cabecera truncada");
  const json = new TextDecoder().decode(new Uint8Array(buf, 8, headerLen));
  const header = JSON.parse(json) as ResimHeader;
  if (!Array.isArray(header.players) || header.players.length === 0) {
    throw new Error("cabecera sin jugadores");
  }
  header.types ??= {};
  header.fps ||= 23.81;

  const stride = 4 + header.players.length * ECO_BYTES + 2;
  const offsets: number[] = [];
  let p = 8 + headerLen;
  while (p + stride <= buf.byteLength) {
    offsets.push(p);
    const units = view.getUint16(p + stride - 2, true);
    p += stride + units * UNIT_BYTES;
    if (p > buf.byteLength) {
      offsets.pop(); // trailing partial sample (interrupted worker) — drop it
      break;
    }
  }
  return new Resim(header, view, Int32Array.from(offsets));
}

/**
 * Where the worker drops the dump for a game. Path building only — this module
 * stays importable from the browser, so no `fs` and no unguarded `process`.
 */
export function resimFilePath(gameId: string): string {
  const env = typeof process !== "undefined" ? process : undefined;
  const dir = env?.env?.REPLAYS_DIR || `${env?.cwd?.() ?? "."}/data/replays`;
  return `${dir}/resim/${gameId}.bin.gz`;
}
