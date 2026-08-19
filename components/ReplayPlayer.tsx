"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FPS,
  fmtTime,
  WORKERS,
  RESOURCE_DEPOTS,
  SUPPLY_COST,
  RACE_LETTER,
  BUILDING_SECONDS,
} from "@/lib/bw";
import { RaceTile } from "@/components/RaceTile";
import type { ViewerData, ViewerEvent, ResimStatus } from "@/lib/viewer-data";
import {
  parseResim,
  deathLowerBound,
  deathsUpTo,
  isPseudoType,
  isEphemeralType,
  isWorkerType,
  shortUnitName,
  type Resim,
} from "@/lib/resim-format";

interface Comment {
  at_seconds: number;
  verdict: "good" | "bad" | "info";
  text: string;
}

/** Timeline marker: the server-side kinds plus the coach's own track. */
interface Mark {
  f: number;
  kind: "expansion" | "tech" | "battle" | "chat" | "leave" | "coach";
  p: number | null;
  label: string;
  comment?: Comment;
}

const MARKER_GLYPH: Record<Mark["kind"], string> = {
  expansion: "◆",
  tech: "▲",
  battle: "●",
  chat: "▪",
  leave: "✕",
  coach: "✦",
};

const SPEEDS = [1, 2, 4, 8, 16];
const TRAIL_SECONDS = 8; // how long an order dot lingers on the map
const HOVER_RADIUS_PX = 14; // screen-space reach of the hover hit-test
const HOVER_THROTTLE_MS = 30;
const HOVER_MAX_ROWS = 7;
const PING_SECONDS = 2;
const CHAT_SECONDS = 9;
const DEFAULT_BUILD_SECONDS = 30;
const DEATH_FLASH_SECONDS = 1; // how long a kill flashes where the unit died

// Dot radius / structure side (at a 700px-wide board) by the unit's size class.
const UNIT_RADIUS = [1.5, 2.2, 3.2];
const BUILDING_SIDE = [7, 9.5, 12.5];

// Painted terrain is beautiful and also loud: this veil pushes it back so the
// units keep owning the board. Matches --void at ~45%.
const TERRAIN_VEIL = "rgba(10,14,20,0.5)";

// Very dark tileset tints — the fallback board when there is no terrain PNG.
const TILESET_BG: Record<string, string> = {
  Jungle: "#0b1410",
  Twilight: "#110f1b",
  Space: "#080b13",
  Desert: "#15110a",
  Ice: "#0b1219",
  Ashworld: "#140f0e",
  Badlands: "#12100b",
  Installation: "#0d1014",
};

const VERDICT_COLOR: Record<string, string> = {
  good: "var(--vespene)",
  bad: "var(--supply-red)",
  info: "var(--minerals)",
};

/** Half-unit supply reads as 11.5 for an odd number of zerglings. */
const fmtSupply = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** First index in a stride-encoded array whose frame is >= target. */
function lowerBound(arr: number[], stride: number, frame: number): number {
  let lo = 0;
  let hi = arr.length / stride;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid * stride] < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Count of values in a sorted array within (from, to]. */
function countBetween(arr: number[], from: number, to: number): number {
  const bound = (v: number) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return bound(to) - bound(from);
}

interface PlayerStats {
  apm: number;
  workers: number;
  bases: number;
  saturation: number;
  supply: number;
  mix: [string, number][];
  upgrades: string[];
  build: ViewerEvent[];
  left: boolean;
}

function statsAt(data: ViewerData, frame: number): Map<number, PlayerStats> {
  const out = new Map<number, PlayerStats>();
  const windowFrames = 60 * FPS;
  for (const p of data.players) {
    const acts = data.actions[p.id] ?? [];
    const elapsed = Math.min(frame, windowFrames) / FPS;
    const recent = countBetween(acts, frame - windowFrames, frame);
    out.set(p.id, {
      apm: elapsed > 5 ? Math.round((recent * 60) / elapsed) : 0,
      workers: 4,
      bases: 1,
      saturation: 21,
      supply: 0,
      mix: [],
      upgrades: [],
      build: [],
      left: data.leaves.some((l) => l.p === p.id && l.f <= frame),
    });
  }

  const mixes = new Map<number, Map<string, number>>();
  for (const e of data.events) {
    if (e.f > frame) break;
    const s = out.get(e.p);
    if (!s) continue;
    if (e.k === "Train" || e.k === "Unit Morph") {
      if (WORKERS.has(e.i)) {
        s.workers++;
      } else {
        s.supply += SUPPLY_COST[e.i] ?? 0;
        const m = mixes.get(e.p) ?? new Map<string, number>();
        m.set(e.i, (m.get(e.i) ?? 0) + 1);
        mixes.set(e.p, m);
        s.build.push(e);
      }
    } else if (e.k === "Upgrade" || e.k === "Tech") {
      s.upgrades.push(e.i);
      s.build.push(e);
    } else {
      if (e.k === "Build" && RESOURCE_DEPOTS.has(e.i)) s.bases++;
      s.build.push(e);
    }
  }
  for (const [id, s] of out) {
    s.saturation = s.bases * 21;
    s.mix = [...(mixes.get(id) ?? new Map())].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }
  return out;
}

/** One aggregated line of the map tooltip ("4× Dragoon — Ze_Pulp"). */
interface HoverRow {
  label: string;
  detail?: string;
  color: string;
  /** units 0 · buildings 1 · terrain resources 2 — the order they're listed in. */
  rank: number;
  count: number;
}

interface HoverInfo {
  /** Cursor position inside the board box, in CSS pixels. */
  x: number;
  y: number;
  rows: HoverRow[];
  more: number;
  /** Set when the card would run past the right/bottom edge of the board. */
  flipX: boolean;
  flipY: boolean;
}

/** Live numbers read straight out of the re-simulation, per screp PlayerID. */
interface RealStats {
  minerals: number;
  gas: number;
  supplyUsed: number; // already halved to in-game units
  supplyMax: number;
  workers: number;
  army: number;
  losses: number;
}

export function ReplayPlayer({
  gameId,
  resimStatus = "pending",
}: {
  gameId: string;
  /** Worker state read server-side; drives the "still cooking" note only. */
  resimStatus?: ResimStatus;
}) {
  const [data, setData] = useState<ViewerData | null>(null);
  const [resim, setResim] = useState<Resim | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [uiFrame, setUiFrame] = useState(0);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [showTech, setShowTech] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const buildListRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const dirtyRef = useRef(true);
  const drawRef = useRef<() => void>(undefined);
  /** Painted terrain, once the PNG arrives; null while loading or on 404. */
  const terrainRef = useRef<HTMLImageElement | null>(null);
  const hoverAtRef = useRef(0);
  // tag → unit index of the *next* sample, rebuilt only when that sample
  // changes (~twice a game second), never per drawn frame.
  const interpRef = useRef<{ sample: number; index: Map<number, number> } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [vd, cm] = await Promise.all([
          fetch(`/api/games/${gameId}/viewer-data`),
          fetch(`/api/games/${gameId}/commentary`),
        ]);
        const body = await vd.json();
        if (!alive) return;
        if (!vd.ok) {
          setError(body.error ?? "No se pudo cargar el replay");
          return;
        }
        setData(body as ViewerData);
        setFocusId(
          (body as ViewerData).players.find((p) => p.isMe)?.id ??
            (body as ViewerData).players[0]?.id ??
            null
        );
        if (cm.ok) setComments(((await cm.json()).comments ?? []) as Comment[]);
      } catch {
        if (alive) setError("Fallo de red al cargar el replay");
      }
    })();
    return () => {
      alive = false;
    };
  }, [gameId]);

  // Layer B: the OpenBW re-simulation. Optional by design — when the worker
  // hasn't produced it (or failed), everything below falls back to the
  // command-derived layer A view.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/games/${gameId}/resim-data`);
        if (!res.ok) return;
        const parsed = parseResim(await res.arrayBuffer());
        if (alive && parsed.sampleCount > 0) {
          interpRef.current = null;
          setResim(parsed);
        }
      } catch {
        // corrupt or half-written dump: stay on layer A
      }
    })();
    return () => {
      alive = false;
    };
  }, [gameId]);

  // The map's real terrain, rendered server-side from the replay's tiles. It is
  // optional: a replay parsed without `-maptiles`, or a tileset we don't have,
  // answers 404 and the board keeps its flat tint.
  useEffect(() => {
    terrainRef.current = null;
    dirtyRef.current = true;
    const img = new Image();
    img.onload = () => {
      terrainRef.current = img;
      dirtyRef.current = true;
    };
    img.src = `/api/games/${gameId}/map-image`;
    return () => {
      img.onload = null;
      terrainRef.current = null;
    };
  }, [gameId]);

  const seek = useCallback(
    (frame: number) => {
      if (!data || !Number.isFinite(frame)) return;
      frameRef.current = Math.min(Math.max(0, frame), data.frames);
      dirtyRef.current = true;
      setUiFrame(frameRef.current);
    },
    [data]
  );

  // Relative jumps read the live frame, not the throttled UI mirror, so two
  // quick clicks on +10s move 20 seconds.
  const nudge = useCallback((deltaSeconds: number) => seek(frameRef.current + deltaSeconds * FPS), [seek]);

  // Colors by re-simulation owner index (the header carries screp PlayerIDs).
  const ownerColors = useMemo(() => {
    if (!data || !resim) return null;
    return resim.header.players.map(
      (rp) => data.players.find((p) => p.id === rp.id)?.color ?? "#9aa8bb"
    );
  }, [data, resim]);

  // --- Canvas: the whole render is a pure function of the current frame ---
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !data) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width;
    const H = cv.height;
    const frame = frameRef.current;
    const sx = W / data.map.widthPx;
    const sy = H / data.map.heightPx;
    const colorOf = new Map(data.players.map((p) => [p.id, p.color]));

    ctx.fillStyle = TILESET_BG[data.map.tileset] ?? "#0b0f16";
    ctx.fillRect(0, 0, W, H);

    const terrain = terrainRef.current;
    if (terrain) {
      ctx.drawImage(terrain, 0, 0, W, H);
      ctx.fillStyle = TERRAIN_VEIL;
      ctx.fillRect(0, 0, W, H);
    } else {
      // Fallback board: a grid every 16 tiles, so the scale is still readable.
      ctx.strokeStyle = "rgba(148,180,220,0.05)";
      ctx.lineWidth = 1;
      for (let x = 512; x < data.map.widthPx; x += 512) {
        ctx.beginPath();
        ctx.moveTo(x * sx, 0);
        ctx.lineTo(x * sx, H);
        ctx.stroke();
      }
      for (let y = 512; y < data.map.heightPx; y += 512) {
        ctx.beginPath();
        ctx.moveTo(0, y * sy);
        ctx.lineTo(W, y * sy);
        ctx.stroke();
      }
    }

    // Resources.
    const dot = (arr: number[], color: string, r: number) => {
      ctx.fillStyle = color;
      for (let i = 0; i < arr.length; i += 2) {
        ctx.beginPath();
        ctx.arc(arr[i] * sx, arr[i + 1] * sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    dot(data.map.minerals, "rgba(77,163,255,0.75)", Math.max(1.2, 2 * sx * 8));
    dot(data.map.geysers, "rgba(88,194,110,0.8)", Math.max(1.5, 2.6 * sx * 8));

    // Start locations: diamonds, tinted when a player spawned there.
    for (let i = 0; i < data.map.starts.length; i += 2) {
      const x = data.map.starts[i] * sx;
      const y = data.map.starts[i + 1] * sy;
      const owner = data.players.find(
        (p) =>
          p.start &&
          Math.abs(p.start[0] - data.map.starts[i]) < 64 &&
          Math.abs(p.start[1] - data.map.starts[i + 1]) < 64
      );
      const r = 7 * (W / 700);
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.strokeStyle = owner ? owner.color : "rgba(148,180,220,0.25)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Order trails: newest last so they sit on top, alpha decays with age.
    const trail = TRAIL_SECONDS * FPS;
    const from = lowerBound(data.orders, 4, frame - trail);
    const to = lowerBound(data.orders, 4, frame);
    for (let i = from; i < to; i++) {
      const f = data.orders[i * 4];
      const kind = Math.floor(data.orders[i * 4 + 3] / 16);
      const pid = data.orders[i * 4 + 3] % 16;
      const age = (frame - f) / trail;
      ctx.globalAlpha = Math.max(0, 0.85 * (1 - age));
      ctx.fillStyle =
        kind === 1 ? "#e25555" : kind === 2 ? "#e0a93e" : (colorOf.get(pid) ?? "#9aa8bb");
      const r = (kind === 0 ? 1.6 : 4.2) * (W / 700);
      ctx.beginPath();
      ctx.arc(data.orders[i * 4 + 1] * sx, data.orders[i * 4 + 2] * sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const useResim = resim != null && ownerColors != null;

    // Structures (layer A): fade in over their build time, expansions get a
    // ring. Skipped entirely once the re-simulation gives us real buildings.
    if (!useResim) {
      for (const e of data.events) {
        if (e.f > frame) break;
        if (e.x == null || e.y == null) continue;
        const built = (BUILDING_SECONDS[e.i] ?? DEFAULT_BUILD_SECONDS) * FPS;
        const progress = Math.min(1, (frame - e.f) / built);
        const color = colorOf.get(e.p) ?? "#9aa8bb";
        const isDepot = RESOURCE_DEPOTS.has(e.i);
        const size = (isDepot ? 13 : 9) * (W / 700);
        const x = e.x * sx;
        const y = e.y * sy;
        ctx.globalAlpha = 0.35 + 0.65 * progress;
        ctx.fillStyle = color;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
        ctx.globalAlpha = 1;
        if (progress < 1) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(x - size / 2 - 2, y - size / 2 - 2, size + 4, size + 4);
        } else if (isDepot) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (size >= 11) {
          ctx.fillStyle = "rgba(10,14,20,0.9)";
          ctx.font = `600 ${Math.round(size * 0.72)}px var(--font-plex-mono), monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(e.i[0], x, y + 0.5);
        }
      }
    }

    // --- Layer B: the real board, straight from the re-simulation ---
    if (useResim) {
      const k = W / 700;
      const s = resim.sampleAtFrame(frame);
      const next = s + 1 < resim.sampleCount ? s + 1 : -1;

      // Interpolate towards the next sample so playback glides instead of
      // stepping every ~0.5s. The tag→index table is cached per sample pair.
      let mix = 0;
      let ahead: Map<number, number> | null = null;
      if (next >= 0) {
        const f0 = resim.frameAt(s);
        const f1 = resim.frameAt(next);
        if (f1 > f0) mix = Math.min(1, Math.max(0, (frame - f0) / (f1 - f0)));
        if (mix > 0) {
          if (interpRef.current?.sample !== next) {
            const index = new Map<number, number>();
            const m = resim.unitCount(next);
            for (let j = 0; j < m; j++) index.set(resim.unitTag(next, j), j);
            interpRef.current = { sample: next, index };
          }
          ahead = interpRef.current.index;
        }
      }

      const n = resim.unitCount(s);
      let last = "";
      // Buildings first: mobile units belong on top of them.
      for (let i = 0; i < n; i++) {
        const info = resim.typeInfo(resim.unitType(s, i));
        if (!info.building) continue;
        if (isPseudoType(info)) continue;
        const color = ownerColors[resim.unitOwner(s, i)] ?? "#9aa8bb";
        if (color !== last) {
          ctx.fillStyle = color;
          last = color;
        }
        const side = (BUILDING_SIDE[info.size] ?? BUILDING_SIDE[1]) * k;
        const x = resim.unitX(s, i) * sx;
        const y = resim.unitY(s, i) * sy;
        const hp = resim.unitHp(s, i);
        // Slightly recessed so the armies read on top of the base.
        ctx.globalAlpha = hp < 100 ? 0.45 + 0.4 * (hp / 100) : 0.85;
        ctx.fillRect(x - side / 2, y - side / 2, side, side);
        ctx.globalAlpha = 1;
        if (hp < 100) {
          ctx.strokeStyle = "rgba(226,85,85,0.7)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x - side / 2 - 1, y - side / 2 - 1, side + 2, side + 2);
          last = "";
        }
      }
      for (let i = 0; i < n; i++) {
        const info = resim.typeInfo(resim.unitType(s, i));
        if (info.building || isPseudoType(info)) continue;
        let px = resim.unitX(s, i);
        let py = resim.unitY(s, i);
        if (ahead) {
          const j = ahead.get(resim.unitTag(s, i));
          if (j !== undefined && resim.unitType(next, j) === resim.unitType(s, i)) {
            px += (resim.unitX(next, j) - px) * mix;
            py += (resim.unitY(next, j) - py) * mix;
          }
        }
        const color = ownerColors[resim.unitOwner(s, i)] ?? "#9aa8bb";
        if (color !== last) {
          ctx.fillStyle = color;
          last = color;
        }
        const r = (UNIT_RADIUS[info.size] ?? UNIT_RADIUS[0]) * k;
        const x = px * sx;
        const y = py * sy;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        const hp = resim.unitHp(s, i);
        if (hp < 100) {
          ctx.strokeStyle = "rgba(226,85,85,0.75)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          // Arc length shows how much health is gone.
          ctx.arc(x, y, r + 1.2 * k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - hp / 100));
          ctx.stroke();
        }
      }

      // Kills: a short flash where the tag vanished.
      const deaths = resim.deathIndex();
      const flash = DEATH_FLASH_SECONDS * FPS;
      const dFrom = deathLowerBound(deaths, frame - flash);
      const dTo = deathLowerBound(deaths, frame + 1);
      ctx.strokeStyle = "#e25555";
      ctx.lineWidth = 1.4;
      for (let i = dFrom; i < dTo; i++) {
        const age = (frame - deaths.frame[i]) / flash;
        ctx.globalAlpha = Math.max(0, 1 - age);
        const x = deaths.x[i] * sx;
        const y = deaths.y[i] * sy;
        const r = (2.5 + 5 * age) * k;
        ctx.beginPath();
        ctx.moveTo(x - r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.moveTo(x + r, y - r);
        ctx.lineTo(x - r, y + r);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Minimap pings as expanding rings.
    const pingFrom = lowerBound(data.pings, 3, frame - PING_SECONDS * FPS);
    const pingTo = lowerBound(data.pings, 3, frame);
    for (let i = pingFrom; i < pingTo; i++) {
      const age = (frame - data.pings[i * 3]) / (PING_SECONDS * FPS);
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = "#e0a93e";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(
        data.pings[i * 3 + 1] * sx,
        data.pings[i * 3 + 2] * sy,
        (4 + 16 * age) * (W / 700),
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [data, resim, ownerColors]);

  useEffect(() => {
    drawRef.current = draw;
    dirtyRef.current = true;
  }, [draw]);

  // --- Hover: what is under the cursor, right now ---
  // Reads the live frame (not the throttled UI mirror) and scans the current
  // sample once; identical things collapse into one counted row.
  const probe = useCallback(
    (clientX: number, clientY: number): HoverInfo | null => {
      const box = boxRef.current;
      if (!box || !data) return null;
      const rect = box.getBoundingClientRect();
      const lx = clientX - rect.left;
      const ly = clientY - rect.top;
      if (lx < 0 || ly < 0 || lx > rect.width || ly > rect.height) return null;

      const kx = rect.width / data.map.widthPx;
      const ky = rect.height / data.map.heightPx;
      const mx = lx / kx;
      const my = ly / ky;
      const reach = HOVER_RADIUS_PX * HOVER_RADIUS_PX;
      const near = (x: number, y: number) => {
        const dx = (x - mx) * kx;
        const dy = (y - my) * ky;
        return dx * dx + dy * dy <= reach;
      };

      const frame = frameRef.current;
      const rows = new Map<string, HoverRow>();
      const add = (key: string, row: Omit<HoverRow, "count">) => {
        const hit = rows.get(key);
        if (hit) hit.count++;
        else rows.set(key, { ...row, count: 1 });
      };

      // A structure below full HP is either going up or taking damage; the only
      // way to tell from a dump without a "completed" flag is to look for the
      // player's own Build order on that spot, still inside its build time.
      const beingBuilt = (x: number, y: number, playerId: number) =>
        data.events.some(
          (e) =>
            e.x != null &&
            e.y != null &&
            e.p === playerId &&
            (e.k === "Build" || e.k === "Land" || e.k === "Building Morph") &&
            e.f <= frame &&
            frame - e.f < (BUILDING_SECONDS[e.i] ?? DEFAULT_BUILD_SECONDS) * FPS &&
            Math.abs(e.x - x) < 96 &&
            Math.abs(e.y - y) < 96
        );

      if (resim) {
        const s = resim.sampleAtFrame(frame);
        const n = s >= 0 ? resim.unitCount(s) : 0;
        for (let i = 0; i < n; i++) {
          const info = resim.typeInfo(resim.unitType(s, i));
          if (isPseudoType(info)) continue;
          const x = resim.unitX(s, i);
          const y = resim.unitY(s, i);
          if (!near(x, y)) continue;
          const owner = resim.header.players[resim.unitOwner(s, i)];
          const p = data.players.find((pl) => pl.id === owner?.id);
          const name = shortUnitName(info.name);
          const hp = resim.unitHp(s, i);
          if (info.building) {
            const state = hp >= 100 ? "" : beingBuilt(x, y, p?.id ?? -1) ? " · en obra" : " · dañado";
            add(`b|${name}|${owner?.id}|${hp}`, {
              label: `${name} — ${p?.name ?? owner?.name ?? "?"}`,
              detail: hp < 100 ? `${hp}%${state}` : undefined,
              color: p?.color ?? "#9aa8bb",
              rank: 1,
            });
          } else {
            add(`u|${name}|${owner?.id}`, {
              label: `${name} — ${p?.name ?? owner?.name ?? "?"}`,
              color: p?.color ?? "#9aa8bb",
              rank: 0,
            });
          }
        }
      } else {
        // Layer A: only the structures the commands placed exist on the board.
        for (const e of data.events) {
          if (e.f > frame) break;
          if (e.x == null || e.y == null || !near(e.x, e.y)) continue;
          const p = data.players.find((pl) => pl.id === e.p);
          const built = (BUILDING_SECONDS[e.i] ?? DEFAULT_BUILD_SECONDS) * FPS;
          const done = frame - e.f >= built;
          add(`a|${e.i}|${e.p}|${done}`, {
            label: `${e.i} — ${p?.name ?? "?"}`,
            detail: done ? undefined : "en obra",
            color: p?.color ?? "#9aa8bb",
            rank: 1,
          });
        }
      }

      const resource = (arr: number[], label: string) => {
        for (let i = 0; i < arr.length; i += 2) {
          if (near(arr[i], arr[i + 1])) add(`r|${label}`, { label, color: "#9aa8bb", rank: 2 });
        }
      };
      resource(data.map.minerals, "Mineral field");
      resource(data.map.geysers, "Vespene geyser");

      if (rows.size === 0) return null;
      const all = [...rows.values()].sort((a, b) => a.rank - b.rank || b.count - a.count);
      return {
        x: lx,
        y: ly,
        rows: all.slice(0, HOVER_MAX_ROWS),
        more: Math.max(0, all.length - HOVER_MAX_ROWS),
        flipX: lx > rect.width - 210,
        flipY: ly > rect.height - 26 * Math.min(all.length, HOVER_MAX_ROWS) - 20,
      };
    },
    [data, resim]
  );

  const onProbeMove = useCallback(
    (e: React.PointerEvent) => {
      const now = performance.now();
      if (now - hoverAtRef.current < HOVER_THROTTLE_MS) return;
      hoverAtRef.current = now;
      setHover(probe(e.clientX, e.clientY));
    },
    [probe]
  );

  // Keep the backing store at device resolution.
  useEffect(() => {
    const box = boxRef.current;
    const cv = canvasRef.current;
    if (!box || !cv) return;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(1, Math.round(box.clientWidth * dpr));
      cv.height = Math.max(1, Math.round(box.clientHeight * dpr));
      dirtyRef.current = true;
      drawRef.current?.();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    return () => ro.disconnect();
  }, [data]);

  // Playback clock. rAF is throttled to zero in hidden tabs, so the elapsed
  // time is re-based on every visibility change instead of jumping forward.
  useEffect(() => {
    if (!data) return;
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const onVisibility = () => {
      last = performance.now();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (playing && !document.hidden) {
        const next = frameRef.current + dt * FPS * speed;
        if (next >= data.frames) {
          frameRef.current = data.frames;
          setPlaying(false);
        } else {
          frameRef.current = next;
        }
        dirtyRef.current = true;
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        drawRef.current?.();
      }
      if (now - lastUi > 100) {
        lastUi = now;
        setUiFrame(frameRef.current);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [data, playing, speed]);

  // Keyboard: space toggles, arrows jump ±10s.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        nudge(-10);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        nudge(10);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nudge]);

  const stats = useMemo(() => (data ? statsAt(data, uiFrame) : null), [data, uiFrame]);

  // Layer B sidebar numbers: one pass over the current sample plus the cached
  // death index — no per-unit objects, so scrubbing stays instant.
  const real = useMemo(() => {
    if (!resim) return null;
    const s = resim.sampleAtFrame(uiFrame);
    if (s < 0) return null;
    const deaths = resim.deathIndex();
    const byId = new Map<number, RealStats>();
    const idxOf = new Map<number, number>();
    resim.header.players.forEach((rp, i) => {
      idxOf.set(rp.id, i);
      byId.set(rp.id, {
        minerals: resim.minerals(s, i),
        gas: resim.gas(s, i),
        supplyUsed: resim.supplyUsed(s, i) / 2,
        supplyMax: resim.supplyMax(s, i) / 2,
        workers: 0,
        army: 0,
        losses: deathsUpTo(deaths, i, uiFrame),
      });
    });

    const focusIdx = focusId != null ? (idxOf.get(focusId) ?? -1) : -1;
    const mix = new Map<string, number>();
    const n = resim.unitCount(s);
    for (let i = 0; i < n; i++) {
      const info = resim.typeInfo(resim.unitType(s, i));
      if (info.building || isPseudoType(info) || isEphemeralType(info)) continue;
      const owner = resim.unitOwner(s, i);
      const st = byId.get(resim.header.players[owner]?.id ?? -1);
      const worker = isWorkerType(info);
      if (st) {
        if (worker) st.workers++;
        else st.army++;
      }
      if (owner === focusIdx && !worker) {
        const unit = shortUnitName(info.name);
        mix.set(unit, (mix.get(unit) ?? 0) + 1);
      }
    }
    return {
      byId,
      aliveMix: [...mix].sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  }, [resim, uiFrame, focusId]);

  const seconds = Math.floor(uiFrame / FPS);

  // Auto-scroll the live build order as it writes itself.
  const buildCount = focusId != null ? (stats?.get(focusId)?.build.length ?? 0) : 0;
  useEffect(() => {
    const el = buildListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buildCount, focusId]);

  async function generateCommentary() {
    setGenBusy(true);
    setGenError(null);
    try {
      const res = await fetch(`/api/games/${gameId}/commentary`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) setGenError(body.error ?? "No se pudo generar el análisis");
      else setComments(body.comments ?? []);
    } catch {
      setGenError("Fallo de red");
    } finally {
      setGenBusy(false);
    }
  }

  if (error) {
    return <p className="card p-5 text-[13px] text-[var(--supply-red)]">{error}</p>;
  }
  if (!data || !stats) {
    return (
      <div className="card flex h-64 items-center justify-center">
        <span className="font-data text-[12px] text-[var(--ink-faint)]">cargando replay…</span>
      </div>
    );
  }

  const aspect = data.map.widthPx / data.map.heightPx;

  // Teams, mine first. The header line only earns its space in a real team game:
  // in 1v1 and FFA every "team" is one player, so the grouping would be noise —
  // the ordering still floats me to the top there.
  const myTeam = data.players.find((p) => p.isMe)?.team ?? null;
  const teamOrder = [...new Set(data.players.map((p) => p.team))].sort((a, b) =>
    a === myTeam ? -1 : b === myTeam ? 1 : a - b
  );
  const showTeams = teamOrder.length > 1 && data.players.length > teamOrder.length;

  const focus = data.players.find((p) => p.id === focusId) ?? data.players[0];
  const focusStats = stats.get(focus.id)!;
  const focusReal = real?.byId.get(focus.id) ?? null;
  const visibleChat = data.chat.filter(
    (c) => c.f <= uiFrame && uiFrame - c.f < CHAT_SECONDS * FPS
  );
  const saidComments = comments.filter((c) => c.at_seconds <= seconds);
  const lastComments = saidComments.slice(-4).reverse();

  const markers: Mark[] = [
    ...data.markers.filter((m) => showTech || m.kind !== "tech"),
    ...comments.map((c) => ({
      f: c.at_seconds * FPS,
      kind: "coach" as const,
      p: null,
      label: c.text,
      comment: c,
    })),
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-3">
        {/* Board */}
        <div className="card relative overflow-hidden p-3">
          <div
            ref={boxRef}
            className="relative mx-auto"
            style={{ aspectRatio: aspect, width: "100%", maxWidth: `calc(70vh * ${aspect})` }}
            onPointerMove={(e) => {
              if (e.pointerType === "mouse") onProbeMove(e);
            }}
            onPointerDown={(e) => {
              // Touch has no hover: a tap opens the tooltip, the next one closes it.
              if (e.pointerType !== "mouse") setHover((h) => (h ? null : probe(e.clientX, e.clientY)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <canvas ref={canvasRef} className="h-full w-full rounded-md" />
            {hover && <HoverCard info={hover} />}
            {/* Chat toasts */}
            <div className="pointer-events-none absolute bottom-2 left-2 space-y-1">
              {visibleChat.map((c, i) => {
                const p = data.players.find((pl) => pl.id === c.p);
                return (
                  <p
                    key={`${c.f}-${i}`}
                    className="font-data rounded-md px-2 py-1 text-[11px]"
                    style={{ background: "rgba(10,14,20,0.8)", color: "var(--ink)" }}
                  >
                    <span style={{ color: p?.color ?? "var(--ink-dim)" }}>{p?.name ?? "?"}</span>:{" "}
                    {c.msg}
                  </p>
                );
              })}
            </div>
          </div>
        </div>

        <Controls
          data={data}
          uiFrame={uiFrame}
          playing={playing}
          speed={speed}
          showTech={showTech}
          resimOn={real != null}
          markers={markers}
          onToggle={() => setPlaying((p) => !p)}
          onSpeed={setSpeed}
          onSeek={seek}
          onNudge={nudge}
          onToggleTech={() => setShowTech((v) => !v)}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/chat?game=${data.id}&t=${fmtTime(seconds)}`}
            className="btn"
            title="Abre el coach con este momento precargado"
          >
            Preguntar sobre este momento
          </Link>
          <button className="btn lg:hidden" onClick={() => setShowPanel((v) => !v)}>
            {showPanel ? "Ocultar panel" : "Ver panel"}
          </button>
          <span className="font-data text-[11px] text-[var(--ink-faint)]">
            espacio = play/pausa · ← → = ±10s
          </span>
          {!real && (resimStatus === "pending" || resimStatus === "running") && (
            <span className="font-data text-[11px] text-[var(--ink-faint)]">
              · Re-simulación en curso — las unidades aparecerán al terminar
            </span>
          )}
        </div>
      </div>

      {/* Sidebar */}
      <aside className={`${showPanel ? "" : "hidden"} space-y-3 lg:block`}>
        {/* Coach track */}
        <section className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--ink-dim)]">
              Coach
            </h3>
            {comments.length > 0 && (
              <span className="font-data text-[10px] text-[var(--ink-faint)]">
                {saidComments.length}/{comments.length}
              </span>
            )}
          </div>
          {comments.length === 0 ? (
            <>
              <p className="mb-3 text-[12px] text-[var(--ink-dim)]">
                Sin análisis todavía. El coach revisa la partida una sola vez y deja comentarios
                anclados a cada momento.
              </p>
              <button className="btn btn-psi w-full justify-center" onClick={generateCommentary} disabled={genBusy}>
                {genBusy ? "Analizando…" : "Generar análisis del coach"}
              </button>
              {genError && (
                <p className="mt-2 text-[11px] text-[var(--supply-red)]">{genError}</p>
              )}
            </>
          ) : lastComments.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-faint)]">
              El primer comentario llega en {fmtTime(comments[0].at_seconds)}.
            </p>
          ) : (
            <div className="space-y-2">
              {lastComments.map((c, i) => (
                <div
                  key={`${c.at_seconds}-${i}`}
                  className="rounded-md p-2"
                  style={{
                    background: i === 0 ? "var(--hud)" : "transparent",
                    borderLeft: `2px solid ${VERDICT_COLOR[c.verdict]}`,
                    opacity: i === 0 ? 1 : 0.6,
                  }}
                >
                  <p className="font-data mb-0.5 text-[10px]" style={{ color: VERDICT_COLOR[c.verdict] }}>
                    {fmtTime(c.at_seconds)} · {c.verdict === "good" ? "bien" : c.verdict === "bad" ? "error" : "info"}
                  </p>
                  <p className="text-[12px] leading-snug text-[var(--ink-dim)]">{c.text}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Live scoreboard */}
        <section className="card p-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--ink-dim)]">
            En vivo
          </h3>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[9px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
                <th className="pb-1 font-medium">Jugador</th>
                <th className="pb-1 text-right font-medium">APM</th>
                <th className="pb-1 text-right font-medium">Wk</th>
                <th className="pb-1 text-right font-medium">Sup</th>
              </tr>
            </thead>
            <tbody>
              {teamOrder.map((team) => {
              const roster = data.players.filter((p) => p.team === team);
              const teamSupply = roster.reduce(
                (n, p) => n + (real?.byId.get(p.id)?.supplyUsed ?? stats.get(p.id)?.supply ?? 0),
                0
              );
              const teamLosses = real
                ? roster.reduce((n, p) => n + (real.byId.get(p.id)?.losses ?? 0), 0)
                : null;
              return (
              <Fragment key={`team-${team}`}>
              {showTeams && (
                <tr className="border-t border-[var(--grid-line-soft)]">
                  <td
                    colSpan={2}
                    className="pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: team === myTeam ? "var(--psi)" : "var(--ink-faint)" }}
                  >
                    {team === myTeam ? "Tu equipo" : `Equipo ${team}`}
                  </td>
                  <td
                    colSpan={2}
                    className="font-data pt-2 pb-1 text-right text-[10px] tabular-nums text-[var(--ink-faint)]"
                    title="supply del equipo · bajas del equipo"
                  >
                    Σ {fmtSupply(teamSupply)}
                    {teamLosses != null && (
                      <>
                        {" · "}
                        <span style={{ color: "var(--supply-red)" }}>✝</span> {teamLosses}
                      </>
                    )}
                  </td>
                </tr>
              )}
              {roster.map((p) => {
                const s = stats.get(p.id)!;
                const r = real?.byId.get(p.id) ?? null;
                return (
                  <Fragment key={p.id}>
                  <tr
                    onClick={() => setFocusId(p.id)}
                    className="cursor-pointer border-t border-[var(--grid-line-soft)]"
                    style={p.id === focus.id ? { background: "var(--hud)" } : undefined}
                  >
                    <td className="py-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-[9px] w-[9px] shrink-0 rounded-[2px]"
                          style={{ background: p.color, opacity: s.left ? 0.3 : 1 }}
                        />
                        <RaceTile letter={RACE_LETTER[p.race] ?? "?"} size={14} />
                        <span
                          className="max-w-[100px] truncate"
                          style={{
                            color: p.isMe ? "var(--psi)" : "var(--ink)",
                            textDecoration: s.left ? "line-through" : undefined,
                          }}
                        >
                          {p.name}
                        </span>
                      </span>
                    </td>
                    <td className="font-data text-right tabular-nums">{s.apm}</td>
                    <td
                      className="font-data text-right tabular-nums"
                      style={{
                        color:
                          (r?.workers ?? s.workers) < s.saturation * 0.8
                            ? "var(--energy)"
                            : "var(--ink-dim)",
                      }}
                    >
                      {r ? r.workers : s.workers}
                    </td>
                    <td className="font-data text-right tabular-nums text-[var(--ink-dim)]">
                      {r ? `${fmtSupply(r.supplyUsed)}/${fmtSupply(r.supplyMax)}` : s.supply}
                    </td>
                  </tr>
                  {r && (
                    <tr
                      onClick={() => setFocusId(p.id)}
                      className="cursor-pointer"
                      style={p.id === focus.id ? { background: "var(--hud)" } : undefined}
                    >
                      <td colSpan={4} className="pb-1">
                        <span className="font-data flex gap-2 pl-[15px] text-[10px] tabular-nums text-[var(--ink-faint)]">
                          <span style={{ color: "var(--minerals)" }}>{r.minerals}</span>
                          <span style={{ color: "var(--vespene)" }}>{r.gas}</span>
                          <span className="ml-auto" title="unidades perdidas hasta este momento">
                            <span style={{ color: "var(--supply-red)" }}>✝</span> {r.losses}
                          </span>
                        </span>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              </Fragment>
              );
              })}
            </tbody>
          </table>
          {real ? (
            <p className="mt-2 text-[10px] leading-snug text-[var(--ink-faint)]">
              Datos reales de la re-simulación: Wk = workers vivos · Sup = supply usado/máximo ·
              minerales / gas en mano · ✝ = unidades perdidas. APM sale de los comandos.
            </p>
          ) : (
            <p className="mt-2 text-[10px] leading-snug text-[var(--ink-faint)]">
              Estimado desde comandos: Wk = workers producidos vs. saturación ({focusStats.bases}{" "}
              base{focusStats.bases !== 1 ? "s" : ""} ≈ {focusStats.saturation}) · Sup = supply de
              ejército producido. Los replays guardan órdenes, no bajas.
            </p>
          )}
        </section>

        {/* Focused player */}
        <section className="card p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="h-[10px] w-[10px] rounded-[2px]" style={{ background: focus.color }} />
            <h3 className="truncate text-[13px] font-semibold">{focus.name}</h3>
          </div>

          <div className="mb-3">
            <div className="mb-1 flex justify-between text-[10px] text-[var(--ink-faint)]">
              <span>
                workers {focusReal ? focusReal.workers : focusStats.workers}
                {focusReal && <span className="text-[var(--ink-ghost)]"> vivos</span>}
              </span>
              <span>saturación ~{focusStats.saturation}</span>
            </div>
            <div className="h-[5px] w-full overflow-hidden rounded-full bg-[var(--hud)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, ((focusReal?.workers ?? focusStats.workers) / focusStats.saturation) * 100)}%`,
                  background:
                    (focusReal?.workers ?? focusStats.workers) < focusStats.saturation * 0.8
                      ? "var(--energy)"
                      : "var(--psi)",
                }}
              />
            </div>
          </div>

          {real && (
            <div className="mb-3">
              <p className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
                <span>Ejército vivo</span>
                <span className="font-data normal-case tracking-normal">
                  {focusReal?.army ?? 0} unidades · ✝ {focusReal?.losses ?? 0}
                </span>
              </p>
              {real.aliveMix.length === 0 ? (
                <p className="font-data text-[11px] text-[var(--ink-ghost)]">sin ejército</p>
              ) : (
                <div className="space-y-0.5">
                  {real.aliveMix.map(([unit, n]) => (
                    <p key={unit} className="font-data flex justify-between text-[11px]">
                      <span className="truncate text-[var(--ink)]">{unit}</span>
                      <span className="tabular-nums">{n}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {focusStats.mix.length > 0 && (
            <div className="mb-3 space-y-0.5">
              {real && (
                <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
                  Producido (comandos)
                </p>
              )}
              {focusStats.mix.map(([unit, n]) => (
                <p key={unit} className="font-data flex justify-between text-[11px]">
                  <span className="truncate text-[var(--ink-dim)]">{unit}</span>
                  <span className="tabular-nums text-[var(--ink-dim)]">{n}</span>
                </p>
              ))}
            </div>
          )}

          {focusStats.upgrades.length > 0 && (
            <p className="mb-3 text-[11px] leading-snug text-[var(--minerals)]">
              {focusStats.upgrades.slice(-4).join(" · ")}
            </p>
          )}

          <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
            Build order en vivo
          </p>
          <div ref={buildListRef} className="font-data max-h-56 overflow-y-auto pr-1 text-[11px]">
            {focusStats.build.length === 0 && (
              <p className="text-[var(--ink-ghost)]">todavía nada</p>
            )}
            {focusStats.build.slice(-120).map((e, i, arr) => (
              <p
                key={`${e.f}-${i}`}
                className="flex gap-2 whitespace-nowrap"
                style={i === arr.length - 1 ? { color: "var(--ink)" } : undefined}
              >
                <span className="text-[var(--ink-ghost)]">{fmtTime(Math.round(e.f / FPS))}</span>
                <span
                  className="truncate"
                  style={{
                    color:
                      i === arr.length - 1
                        ? "var(--psi)"
                        : e.k === "Upgrade" || e.k === "Tech"
                          ? "var(--minerals)"
                          : "var(--ink-dim)",
                  }}
                >
                  {e.i}
                </span>
              </p>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

/** What sits under the cursor on the board — pinned to it, never in its way. */
function HoverCard({ info }: { info: HoverInfo }) {
  return (
    <div
      className="card font-data pointer-events-none absolute z-10 max-w-[240px] px-2 py-1.5 text-[11px] leading-[1.5]"
      style={{
        left: info.x + (info.flipX ? -12 : 12),
        top: info.y + (info.flipY ? -12 : 12),
        transform: `translate(${info.flipX ? "-100%" : "0"}, ${info.flipY ? "-100%" : "0"})`,
        background: "rgba(10,14,20,0.94)",
      }}
    >
      {info.rows.map((r, i) => (
        <p key={i} className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
            style={{ background: r.color }}
          />
          {r.count > 1 && <span className="tabular-nums text-[var(--ink)]">{r.count}×</span>}
          <span className="truncate text-[var(--ink)]">{r.label}</span>
          {r.detail && <span className="text-[var(--supply-red)]">{r.detail}</span>}
        </p>
      ))}
      {info.more > 0 && <p className="text-[var(--ink-faint)]">+{info.more} más</p>}
    </div>
  );
}

function Controls({
  data,
  uiFrame,
  playing,
  speed,
  showTech,
  resimOn,
  markers,
  onToggle,
  onSpeed,
  onSeek,
  onNudge,
  onToggleTech,
}: {
  data: ViewerData;
  uiFrame: number;
  playing: boolean;
  speed: number;
  showTech: boolean;
  resimOn: boolean;
  markers: Mark[];
  onToggle: () => void;
  onSpeed: (s: number) => void;
  onSeek: (f: number) => void;
  onNudge: (seconds: number) => void;
  onToggleTech: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const colorOf = (p: number | null): string =>
    (p != null ? data.players.find((pl) => pl.id === p)?.color : null) ?? "var(--ink-faint)";

  const seekFromEvent = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0) onSeek(((clientX - r.left) / r.width) * data.frames);
  };

  return (
    <div className="card p-3">
      {/* Marker lane */}
      <div className="relative mb-1 h-[14px]">
        {markers.map((m, i) => (
          <button
            key={i}
            onClick={() => onSeek(m.f)}
            title={`${fmtTime(Math.round(m.f / FPS))} — ${m.label}`}
            className="absolute -translate-x-1/2 text-[9px] leading-none"
            style={{
              left: `${(m.f / data.frames) * 100}%`,
              color: m.comment
                ? VERDICT_COLOR[m.comment.verdict]
                : m.kind === "battle"
                  ? "var(--supply-red)"
                  : m.kind === "chat"
                    ? "var(--ink-faint)"
                    : colorOf(m.p),
              top: m.kind === "expansion" || m.kind === "tech" ? 6 : 0,
            }}
          >
            {MARKER_GLYPH[m.kind]}
          </button>
        ))}
      </div>

      {/* Scrub bar */}
      <div
        ref={barRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFromEvent(e.clientX);
        }}
        className="relative h-[10px] cursor-pointer rounded-full"
        style={{ background: "var(--hud)" }}
      >
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${(uiFrame / data.frames) * 100}%`, background: "var(--psi-dim)" }}
        />
        <div
          className="pointer-events-none absolute top-1/2 h-[14px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${(uiFrame / data.frames) * 100}%`, background: "var(--psi)" }}
        />
      </div>

      {/* Transport */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-psi w-[86px] justify-center" onClick={onToggle}>
          {playing ? "Pausa" : "Reproducir"}
        </button>
        <button className="btn" onClick={() => onNudge(-10)} title="Retroceder 10s">
          −10s
        </button>
        <button className="btn" onClick={() => onNudge(10)} title="Adelantar 10s">
          +10s
        </button>
        <span className="font-data ml-1 text-[13px] tabular-nums">
          {fmtTime(Math.floor(uiFrame / FPS))}
          <span className="text-[var(--ink-faint)]"> / {fmtTime(data.durationSeconds)}</span>
        </span>
        {resimOn && (
          <span
            className="font-data rounded-md px-1.5 py-0.5 text-[10px]"
            style={{ background: "var(--psi-dim)", color: "var(--psi)" }}
            title="Unidades, economía y bajas vienen de la re-simulación OpenBW, no de los comandos"
          >
            Simulación completa
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => onSpeed(s)}
              className="font-data rounded-md px-2 py-1 text-[11px]"
              style={
                s === speed
                  ? { background: "var(--psi-dim)", color: "var(--psi)" }
                  : { color: "var(--ink-faint)" }
              }
            >
              {s}×
            </button>
          ))}
          <button
            onClick={onToggleTech}
            className="font-data ml-1 rounded-md px-2 py-1 text-[11px]"
            style={
              showTech
                ? { background: "var(--hud-bright)", color: "var(--ink)" }
                : { color: "var(--ink-faint)" }
            }
            title="Mostrar marcadores de upgrades y tech"
          >
            ▲ tech
          </button>
        </span>
      </div>
    </div>
  );
}
