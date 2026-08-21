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
  UNIT_SECONDS,
  RESEARCH_SECONDS,
} from "@/lib/bw";
import type { ViewerData, ViewerEvent, ResimStatus } from "@/lib/viewer-data";
import {
  parseResim,
  deathLowerBound,
  deathsUpTo,
  isPseudoType,
  isEphemeralType,
  isWorkerType,
  shortUnitName,
  unitClass,
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
const UNIT_RADIUS = [2.1, 3, 4.2];
const BUILDING_SIDE = [8, 11, 14];

// Combat halos: recent deaths cluster into a pulsing ring on the zone.
const COMBAT_WINDOW_SECONDS = 10;
const COMBAT_CLUSTER_PX = 160; // map pixels — deaths closer than this share a halo

// Painted terrain is beautiful and also loud: this veil pushes it back so the
// units keep owning the board. Matches --void at ~50%.
const TERRAIN_VEIL = "rgba(7,17,13,0.5)";

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

/** History chart: how many time buckets each player series carries. */
const BUCKETS = 140;
const BAR_GROUPS = 28;

type MetricKey = "min" | "gas" | "sup" | "wk" | "army" | "bajas" | "apm" | "hk";
type ViewMode = "teams" | "all" | "focus";
type ChartType = "line" | "area" | "bars";

const METRICS: { key: MetricKey; label: string; unit: string; resim: boolean }[] = [
  { key: "min", label: "Minerales", unit: "banco", resim: true },
  { key: "gas", label: "Gas", unit: "banco", resim: true },
  { key: "sup", label: "Supply", unit: "usado", resim: true },
  { key: "wk", label: "Workers", unit: "vivos", resim: true },
  { key: "army", label: "Ejército", unit: "unidades vivas", resim: true },
  { key: "bajas", label: "Bajas", unit: "acumuladas", resim: true },
  { key: "apm", label: "APM", unit: "ventana 60s", resim: false },
  { key: "hk", label: "Hotkeys %", unit: "% de acciones · ventana 60s", resim: false },
];

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
  /** Sum of unit HP% across the group — averaged into `detail` at the end. */
  hpSum?: number;
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
  larvae: number;
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
  // Shape class per typeId, resolved once per dump — regexing names every
  // frame for hundreds of units would burn the draw budget.
  const typeClasses = useMemo(() => {
    const m = new Map<number, 0 | 1 | 2>();
    if (resim) {
      for (const [id, info] of Object.entries(resim.header.types)) {
        m.set(Number(id), unitClass(info));
      }
    }
    return m;
  }, [resim]);

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
      ctx.strokeStyle = "rgba(84,232,150,0.06)";
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

    // Resources: minerals are blue diamonds (crystals), geysers green hexagons.
    const diamond = (x: number, y: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
    };
    const hexagon = (x: number, y: number, r: number) => {
      ctx.beginPath();
      for (let a = 0; a < 6; a++) {
        const ang = (Math.PI / 3) * a - Math.PI / 6;
        const px = x + r * Math.cos(ang);
        const py = y + r * Math.sin(ang);
        if (a === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = "rgba(77,163,255,0.8)";
    const mr = Math.max(1.8, 2.8 * sx * 8);
    for (let i = 0; i < data.map.minerals.length; i += 2) {
      diamond(data.map.minerals[i] * sx, data.map.minerals[i + 1] * sy, mr);
    }
    ctx.fillStyle = "rgba(88,194,110,0.85)";
    const gr = Math.max(2.2, 3.4 * sx * 8);
    for (let i = 0; i < data.map.geysers.length; i += 2) {
      hexagon(data.map.geysers[i] * sx, data.map.geysers[i + 1] * sy, gr);
    }

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
        const cls = typeClasses.get(resim.unitType(s, i)) ?? 0;
        if (cls === 1) {
          // mech terrestre: cuadrado
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        } else if (cls === 2) {
          // aéreo: triángulo
          const t = r * 1.3;
          ctx.beginPath();
          ctx.moveTo(x, y - t);
          ctx.lineTo(x + t * 0.9, y + t * 0.72);
          ctx.lineTo(x - t * 0.9, y + t * 0.72);
          ctx.closePath();
          ctx.fill();
        } else {
          // bio: círculo
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
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

      // Combat halos: deaths of the last few seconds cluster into a pulsing
      // ring with the casualty count — the "aquí está la pelea" pin.
      const win = COMBAT_WINDOW_SECONDS * FPS;
      const cFrom = deathLowerBound(deaths, frame - win);
      const cTo = deathLowerBound(deaths, frame + 1);
      if (cTo > cFrom) {
        // Greedy clustering on a running centroid — the window holds few deaths.
        const clusters: { sx: number; sy: number; n: number; latest: number }[] = [];
        for (let i = cFrom; i < cTo; i++) {
          const x = deaths.x[i];
          const y = deaths.y[i];
          let hit = null;
          for (const c of clusters) {
            if (
              Math.abs(c.sx / c.n - x) < COMBAT_CLUSTER_PX &&
              Math.abs(c.sy / c.n - y) < COMBAT_CLUSTER_PX
            ) {
              hit = c;
              break;
            }
          }
          if (hit) {
            hit.sx += x;
            hit.sy += y;
            hit.n++;
            if (deaths.frame[i] > hit.latest) hit.latest = deaths.frame[i];
          } else {
            clusters.push({ sx: x, sy: y, n: 1, latest: deaths.frame[i] });
          }
        }
        for (const c of clusters) {
          if (c.n < 2) continue; // a stray death is not a battle
          const cx = (c.sx / c.n) * sx;
          const cy = (c.sy / c.n) * sy;
          const fade = Math.max(0, 1 - (frame - c.latest) / win);
          const pulse = 0.8 + 0.2 * Math.sin(frame / 5);
          const rr = (13 + Math.min(24, c.n * 2)) * k;
          ctx.strokeStyle = "#e25555";
          ctx.lineWidth = 1.6;
          ctx.globalAlpha = 0.55 * fade * pulse;
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = Math.min(1, 0.35 + 0.65 * fade);
          ctx.fillStyle = "#e25555";
          ctx.font = `700 ${Math.round(9.5 * k)}px var(--font-plex-mono), monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(`✕${c.n}`, cx, cy - rr - 6 * k);
        }
        ctx.globalAlpha = 1;
      }
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
  }, [data, resim, ownerColors, typeClasses]);

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
        if (hit) {
          hit.count++;
          if (row.hpSum != null) hit.hpSum = (hit.hpSum ?? 0) + row.hpSum;
        } else rows.set(key, { ...row, count: 1 });
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
              hpSum: hp,
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
      // Group HP: the average across the stack, only shown when someone bleeds.
      for (const row of rows.values()) {
        if (row.hpSum == null || row.count === 0) continue;
        const avg = Math.round(row.hpSum / row.count);
        if (avg < 100) row.detail = `${avg}% vida`;
      }
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
        larvae: 0,
        losses: deathsUpTo(deaths, i, uiFrame),
      });
    });

    const focusIdx = focusId != null ? (idxOf.get(focusId) ?? -1) : -1;
    const mix = new Map<string, number>();
    const bldgs = new Map<string, number>();
    const n = resim.unitCount(s);
    for (let i = 0; i < n; i++) {
      const info = resim.typeInfo(resim.unitType(s, i));
      if (isPseudoType(info)) continue;
      const owner = resim.unitOwner(s, i);
      const st = byId.get(resim.header.players[owner]?.id ?? -1);
      if (info.building) {
        if (owner === focusIdx) {
          const b = shortUnitName(info.name);
          bldgs.set(b, (bldgs.get(b) ?? 0) + 1);
        }
        continue;
      }
      if (st && /larva/i.test(info.name)) st.larvae++;
      if (isEphemeralType(info)) continue;
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

    // Bank drift over the last minute: how the pile moved, signed.
    let drift: { min: number; gas: number } | null = null;
    if (focusIdx >= 0) {
      const back = resim.sampleAtFrame(uiFrame - 60 * FPS);
      if (back >= 0 && back < s) {
        const dt = (resim.frameAt(s) - resim.frameAt(back)) / FPS;
        if (dt > 10) {
          drift = {
            min: Math.round(((resim.minerals(s, focusIdx) - resim.minerals(back, focusIdx)) * 60) / dt),
            gas: Math.round(((resim.gas(s, focusIdx) - resim.gas(back, focusIdx)) * 60) / dt),
          };
        }
      }
    }

    return {
      byId,
      aliveMix: [...mix].sort((a, b) => b[1] - a[1]).slice(0, 6),
      buildings: [...bldgs].sort((a, b) => b[1] - a[1]).slice(0, 6),
      drift,
    };
  }, [resim, uiFrame, focusId]);

  // Full-history series for every player: built once per game, read by the
  // chart under the board. Layer A only carries APM; layer B adds the rest.
  const series = useMemo(() => {
    if (!data) return null;
    const frames = Math.max(1, data.frames);
    const per = new Map<number, Partial<Record<MetricKey, Float64Array>>>();
    for (const p of data.players) per.set(p.id, { apm: new Float64Array(BUCKETS) });

    const windowF = 60 * FPS;
    for (const p of data.players) {
      const acts = data.actions[p.id] ?? [];
      const hks = data.hotkeys?.[p.id] ?? [];
      const rec = per.get(p.id)!;
      const apm = rec.apm!;
      const hk = new Float64Array(BUCKETS);
      rec.hk = hk;
      for (let b = 0; b < BUCKETS; b++) {
        const f = ((b + 1) / BUCKETS) * frames;
        const elapsed = Math.min(f, windowF) / FPS;
        const total = countBetween(acts, f - windowF, f);
        apm[b] = elapsed > 5 ? Math.round((total * 60) / elapsed) : 0;
        hk[b] = total > 0 ? Math.round((1000 * countBetween(hks, f - windowF, f)) / total) / 10 : 0;
      }
    }

    if (resim) {
      for (const rec of per.values()) {
        for (const k of ["min", "gas", "sup", "wk", "army", "bajas"] as const) {
          rec[k] = new Float64Array(BUCKETS);
        }
      }
      const idxOf = new Map(resim.header.players.map((rp, i) => [rp.id, i]));
      const deaths = resim.deathIndex();
      const wk = new Int32Array(resim.playerCount);
      const army = new Int32Array(resim.playerCount);
      for (let b = 0; b < BUCKETS; b++) {
        const f = ((b + 1) / BUCKETS) * frames;
        const s = resim.sampleAtFrame(f);
        if (s < 0) continue;
        wk.fill(0);
        army.fill(0);
        const n = resim.unitCount(s);
        for (let i = 0; i < n; i++) {
          const info = resim.typeInfo(resim.unitType(s, i));
          if (info.building || isPseudoType(info) || isEphemeralType(info)) continue;
          const o = resim.unitOwner(s, i);
          if (o >= resim.playerCount) continue;
          if (isWorkerType(info)) wk[o]++;
          else army[o]++;
        }
        for (const p of data.players) {
          const i = idxOf.get(p.id);
          if (i == null) continue;
          const rec = per.get(p.id)!;
          rec.min![b] = resim.minerals(s, i);
          rec.gas![b] = resim.gas(s, i);
          rec.sup![b] = resim.supplyUsed(s, i) / 2;
          rec.wk![b] = wk[i];
          rec.army![b] = army[i];
          rec.bajas![b] = deathsUpTo(deaths, i, f);
        }
      }
    }
    return per;
  }, [data, resim]);

  const seconds = Math.floor(uiFrame / FPS);

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
  if (!data || !stats || !series) {
    return (
      <div className="card flex h-64 items-center justify-center">
        <span className="font-data text-[12px] text-[var(--ink-faint)]">cargando replay…</span>
      </div>
    );
  }

  const aspect = data.map.widthPx / data.map.heightPx;

  // Teams, mine first. Grouping only earns its space in a real team game.
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
  const coachNow = saidComments[saidComments.length - 1] ?? null;

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

  // Live production queue of the focused player: everything ordered whose
  // (approximate) build time hasn't elapsed yet at the playhead.
  const prodQueue: { name: string; pct: number; eta: number; tech: boolean }[] = [];
  for (const e of data.events) {
    if (e.f > uiFrame) break;
    if (e.p !== focus.id) continue;
    let dur: number | null = null;
    let tech = false;
    if (e.k === "Train" || e.k === "Unit Morph") dur = UNIT_SECONDS[e.i] ?? 25;
    else if (e.k === "Build" || e.k === "Building Morph")
      dur = BUILDING_SECONDS[e.i] ?? DEFAULT_BUILD_SECONDS;
    else if (e.k === "Upgrade" || e.k === "Tech") {
      dur = RESEARCH_SECONDS;
      tech = true;
    }
    if (dur == null) continue;
    const done = (uiFrame - e.f) / (dur * FPS);
    if (done >= 1) continue;
    prodQueue.push({
      name: e.i,
      pct: Math.round(done * 100),
      eta: Math.max(1, Math.round(dur - (uiFrame - e.f) / FPS)),
      tech,
    });
  }
  const prodShown = prodQueue.slice(-7);

  // Layer A fallback for the buildings grid: what the commands placed so far.
  const bldgsA = new Map<string, number>();
  if (!real) {
    for (const e of data.events) {
      if (e.f > uiFrame) break;
      if (e.p === focus.id && (e.k === "Build" || e.k === "Building Morph"))
        bldgsA.set(e.i, (bldgsA.get(e.i) ?? 0) + 1);
    }
  }
  const buildings = real ? real.buildings : [...bldgsA].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_412px]">
      {/* ── Left column: board · timeline · full history ─────────────────── */}
      <div className="min-w-0 space-y-2.5">
        {/* Board — clipped corners, phosphor frame */}
        <div
          className="relative overflow-hidden border"
          style={{
            borderColor: "rgba(84,232,150,0.28)",
            background: "#07110d",
            clipPath:
              "polygon(0 10px, 10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%)",
          }}
        >
          <div
            ref={boxRef}
            className="relative mx-auto"
            style={{ aspectRatio: aspect, width: "100%", maxWidth: `calc(66vh * ${aspect})` }}
            onPointerMove={(e) => {
              if (e.pointerType === "mouse") onProbeMove(e);
            }}
            onPointerDown={(e) => {
              // Touch has no hover: a tap opens the tooltip, the next one closes it.
              if (e.pointerType !== "mouse") setHover((h) => (h ? null : probe(e.clientX, e.clientY)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <canvas ref={canvasRef} className="h-full w-full" />
            {hover && <HoverCard info={hover} />}

            {/* Rosters over the board: per team in team games, per player in 1v1 */}
            <div className="absolute left-2 top-2 flex flex-col gap-1.5">
              {teamOrder.map((team) => {
                const roster = data.players.filter((p) => p.team === team);
                const mineTeam = team === myTeam;
                const teamSupply = roster.reduce(
                  (n, p) => n + (real?.byId.get(p.id)?.supplyUsed ?? stats.get(p.id)?.supply ?? 0),
                  0
                );
                return (
                  <div
                    key={team}
                    className="flex items-center gap-2 border px-2 py-1 backdrop-blur-[6px]"
                    style={{
                      background: mineTeam ? "rgba(6,16,13,0.85)" : "rgba(6,16,13,0.72)",
                      borderColor: mineTeam ? "rgba(84,232,150,0.4)" : "rgba(84,232,150,0.18)",
                    }}
                  >
                    {showTeams && (
                      <span
                        className="font-data text-[9px] font-semibold tracking-[0.14em]"
                        style={{ color: mineTeam ? "var(--psi)" : "var(--ink-faint)" }}
                      >
                        {mineTeam ? "TU EQUIPO" : `EQUIPO ${team}`}
                      </span>
                    )}
                    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                      {roster.map((p) => {
                        const r = real?.byId.get(p.id) ?? null;
                        const s = stats.get(p.id)!;
                        const sup = r ? r.supplyUsed : s.supply;
                        return (
                          <button
                            key={p.id}
                            onClick={() => setFocusId(p.id)}
                            className="font-data flex cursor-pointer items-center gap-1 text-[10px]"
                            style={{
                              color:
                                p.id === focus.id ? "var(--ink)" : "rgba(223,250,234,0.72)",
                              textDecoration: s.left ? "line-through" : undefined,
                            }}
                            title={`${p.name} · ver su momento`}
                          >
                            <span className="h-[7px] w-[7px]" style={{ background: p.color }} />
                            {p.name}
                            <span style={{ color: "var(--ink-faint)" }}>{fmtSupply(sup)}</span>
                          </button>
                        );
                      })}
                    </span>
                    {showTeams && (
                      <span className="font-data text-[10px] font-semibold text-[var(--gold)]">
                        Σ {fmtSupply(teamSupply)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Chat toasts */}
            <div className="pointer-events-none absolute bottom-2 left-2 space-y-1">
              {visibleChat.map((c, i) => {
                const p = data.players.find((pl) => pl.id === c.p);
                return (
                  <p
                    key={`${c.f}-${i}`}
                    className="font-data px-2 py-1 text-[11px]"
                    style={{ background: "rgba(4,10,8,0.85)", color: "var(--ink)" }}
                  >
                    <span style={{ color: p?.color ?? "var(--ink-dim)" }}>{p?.name ?? "?"}</span>:{" "}
                    {c.msg}
                  </p>
                );
              })}
            </div>
          </div>
        </div>

        {/* Leyenda de figuras del tablero */}
        <div className="font-data flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-[var(--ink-faint)]">
          <span>● bio</span>
          <span>■ mech</span>
          <span>▲ aéreo</span>
          <span className="text-[var(--ink-ghost)]">·</span>
          <span style={{ color: "#4da3ff" }}>◆ minerales</span>
          <span style={{ color: "#58c26e" }}>⬡ gas</span>
          <span className="text-[var(--ink-ghost)]">·</span>
          <span>▪ edificio</span>
          <span style={{ color: "#e25555" }}>◯✕n combate (bajas 10s)</span>
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
          onToggleTech={() => setShowTech((v) => !v)}
        />

        <HistoryPanel
          data={data}
          series={series}
          hasResim={resim != null}
          uiFrame={uiFrame}
          focusId={focus.id}
          myTeam={myTeam}
          showTeams={showTeams}
          teamOrder={teamOrder}
          onSeek={seek}
        />

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn xl:hidden" onClick={() => setShowPanel((v) => !v)}>
            {showPanel ? "Ocultar momento" : "Ver momento"}
          </button>
          <span className="font-data text-[10px] text-[var(--ink-faint)]">
            espacio = play/pausa · ← → = ±10s · clic en cualquier gráfica para saltar
          </span>
          {!real && (resimStatus === "pending" || resimStatus === "running") && (
            <span className="font-data text-[10px] text-[var(--ink-faint)]">
              · Re-simulación en curso — economía y ejército aparecerán al terminar
            </span>
          )}
        </div>
      </div>

      {/* ── Right column: this exact moment, one player at a time ────────── */}
      <aside className={`${showPanel ? "" : "hidden"} min-w-0 space-y-2.5 xl:block`}>
        <MomentHeader
          players={data.players}
          focus={focus}
          seconds={seconds}
          myTeam={myTeam}
          showTeams={showTeams}
          onPick={setFocusId}
        />

        {/* Snapshot: economy + supply + APM */}
        <section className="card px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="h-[9px] w-[9px] shrink-0" style={{ background: focus.color }} />
            <h3 className="truncate text-[13px] font-semibold">{focus.name}</h3>
            <span className="font-data border px-1.5 py-px text-[10px] font-semibold text-[var(--ink-faint)]">
              {RACE_LETTER[focus.race] ?? "?"}
            </span>
            {focus.isMe && (
              <span
                className="font-data border px-1.5 py-px text-[9px] font-semibold tracking-[0.1em]"
                style={{ color: "var(--gold)", borderColor: "var(--gold-line)" }}
              >
                TÚ
              </span>
            )}
            <span className="font-data ml-auto text-[10px] text-[var(--ink-faint)]">
              {focusStats.bases} base{focusStats.bases !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="MINERALES"
              value={focusReal ? String(focusReal.minerals) : "—"}
              color="var(--minerals)"
              sub={
                focusReal
                  ? `${real?.drift ? `Δ ${real.drift.min > 0 ? "+" : ""}${real.drift.min}/min · ` : ""}${focusReal.workers} wk`
                  : `${focusStats.workers} wk producidos`
              }
            />
            <Stat
              label="GAS"
              value={focusReal ? String(focusReal.gas) : "—"}
              color="var(--vespene)"
              sub={
                focusReal && real?.drift
                  ? `Δ ${real.drift.gas > 0 ? "+" : ""}${real.drift.gas}/min`
                  : "banco"
              }
            />
            <Stat
              label="SUPPLY"
              value={
                focusReal
                  ? `${fmtSupply(focusReal.supplyUsed)}/${fmtSupply(focusReal.supplyMax)}`
                  : fmtSupply(focusStats.supply)
              }
              color="var(--ink)"
              sub={
                focusReal && focusReal.larvae > 0
                  ? `larvas ${focusReal.larvae}`
                  : focusReal
                    ? `✝ ${focusReal.losses} bajas`
                    : "producido"
              }
            />
          </div>

          <div
            className="mt-2.5 flex items-baseline gap-2.5 border-t pt-2.5"
            style={{ borderColor: "var(--grid-line-soft)" }}
          >
            <span className="font-data text-[9px] font-medium tracking-[0.12em] text-[var(--ink-faint)]">
              APM AHORA
            </span>
            <span className="font-data text-[16px] font-semibold">{focusStats.apm}</span>
            <ApmSpark series={series.get(focus.id)?.apm} uiFrame={uiFrame} frames={data.frames} />
          </div>
        </section>

        {/* Live production queue */}
        <section
          className="border px-3 py-2.5 backdrop-blur-[6px]"
          style={{ borderColor: "rgba(255,207,63,0.32)", background: "rgba(26,21,6,0.5)" }}
        >
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-data text-[9px] font-semibold tracking-[0.16em] text-[var(--gold)]">
              EN PRODUCCIÓN
            </span>
            <span className="font-data ml-auto text-[9.5px] text-[rgba(255,207,63,0.6)]">
              cola viva · tiempos aprox.
            </span>
          </div>
          {prodShown.length === 0 ? (
            <p className="font-data text-[11px] text-[var(--ink-ghost)]">nada en cola</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {prodShown.map((p, i) => (
                <div key={`${p.name}-${i}`} className="flex items-center gap-2">
                  <span
                    className="font-data flex h-5 w-5 flex-none items-center justify-center border text-[9px] font-semibold"
                    style={
                      p.tech
                        ? { borderColor: "rgba(77,163,255,0.5)", color: "var(--minerals)" }
                        : { borderColor: "rgba(255,207,63,0.5)", color: "var(--gold)" }
                    }
                  >
                    {p.tech ? "↑" : "▲"}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-[11.5px]"
                    style={{ color: p.tech ? "#cfe6ff" : "#f2e6c4" }}
                  >
                    {p.name}
                  </span>
                  <div
                    className="h-[5px] w-[74px] flex-none"
                    style={{ background: p.tech ? "rgba(77,163,255,0.14)" : "rgba(255,207,63,0.14)" }}
                  >
                    <div
                      className="h-full"
                      style={{
                        width: `${p.pct}%`,
                        background: p.tech ? "var(--minerals)" : "var(--gold)",
                      }}
                    />
                  </div>
                  <span
                    className="font-data w-[34px] flex-none text-right text-[10px]"
                    style={{ color: p.tech ? "rgba(207,230,255,0.7)" : "rgba(255,207,63,0.7)" }}
                  >
                    {p.eta}s
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Standing buildings */}
        <section className="card px-3 py-2.5">
          <p className="hud-label mb-2">Edificios</p>
          {buildings.length === 0 ? (
            <p className="font-data text-[11px] text-[var(--ink-ghost)]">todavía nada</p>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 min-[480px]:grid-cols-3">
              {buildings.map(([name, n]) => (
                <div
                  key={name}
                  className="flex items-center gap-1.5 border px-1.5 py-1"
                  style={{ borderColor: "var(--grid-line-soft)" }}
                >
                  <span
                    className="h-[13px] w-[16px] flex-none border"
                    style={{ background: "var(--gold-dim)", borderColor: "rgba(255,207,63,0.45)" }}
                  />
                  <span className="font-data min-w-0 truncate text-[10px] text-[var(--ink-dim)]">
                    {name}
                  </span>
                  <span className="font-data ml-auto text-[11px] font-semibold">{n}</span>
                </div>
              ))}
            </div>
          )}
          {!real && buildings.length > 0 && (
            <p className="font-data mt-1.5 text-[9px] text-[var(--ink-ghost)]">
              colocados por comandos — sin re-simulación no se ven las pérdidas
            </p>
          )}
        </section>

        {/* Standing army */}
        <section className="card px-3 py-2.5">
          <div className="mb-2 flex items-baseline gap-2">
            <p className="hud-label">Ejército en campo</p>
            <span className="font-data ml-auto text-[9.5px] text-[var(--ink-faint)]">
              {real
                ? `${focusReal?.army ?? 0} unidades · ✝ ${focusReal?.losses ?? 0}`
                : "producido (comandos)"}
            </span>
          </div>
          {(real ? real.aliveMix : focusStats.mix).length === 0 ? (
            <p className="font-data text-[11px] text-[var(--ink-ghost)]">sin ejército</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {(real ? real.aliveMix : focusStats.mix).map(([unit, n], _, arr) => {
                const max = arr[0]?.[1] ?? 1;
                return (
                  <div key={unit} className="flex items-center gap-2">
                    <span
                      className="font-data flex h-[18px] w-[18px] flex-none items-center justify-center border text-[8px] font-semibold"
                      style={{ borderColor: "rgba(84,232,150,0.3)", color: "#a8f0cb" }}
                    >
                      ◆
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px]">{unit}</span>
                    <div
                      className="h-[5px] w-[70px] flex-none"
                      style={{ background: "rgba(84,232,150,0.12)" }}
                    >
                      <div
                        className="h-full"
                        style={{ width: `${(n / max) * 100}%`, background: "var(--psi)" }}
                      />
                    </div>
                    <span className="font-data w-[22px] flex-none text-right text-[11px] font-semibold">
                      {n}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {focusStats.upgrades.length > 0 && (
            <p
              className="mt-2 border-t pt-2 text-[10.5px] leading-snug text-[var(--minerals)]"
              style={{ borderColor: "var(--grid-line-soft)" }}
            >
              {focusStats.upgrades.slice(-4).join(" · ")}
            </p>
          )}
        </section>

        {/* Coach, anchored to this instant */}
        <section
          className="border px-3 py-2.5 backdrop-blur-[8px]"
          style={{
            borderColor: "var(--gold-line)",
            background: "linear-gradient(180deg, rgba(38,30,8,0.75), rgba(12,16,12,0.7))",
          }}
        >
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className="font-data flex h-5 w-5 items-center justify-center rounded-full border-2 text-[10px] font-semibold"
              style={{ borderColor: "var(--gold)", color: "var(--gold)" }}
            >
              ✦
            </span>
            <span className="font-data text-[9.5px] font-semibold tracking-[0.16em] text-[var(--gold)]">
              COACH · EN ESTE MOMENTO
            </span>
            {comments.length > 0 && (
              <span className="font-data ml-auto text-[9.5px] text-[rgba(255,207,63,0.55)]">
                {saidComments.length}/{comments.length}
              </span>
            )}
          </div>
          {comments.length === 0 ? (
            <>
              <p className="text-[12px] leading-snug" style={{ color: "rgba(242,230,196,0.8)" }}>
                Sin análisis todavía. El coach revisa la partida una vez y deja comentarios
                anclados a cada momento.
              </p>
              <button
                className="btn btn-gold mt-2 px-2.5 py-1.5 text-[10px] font-semibold tracking-[0.08em]"
                onClick={generateCommentary}
                disabled={genBusy}
              >
                {genBusy ? "ANALIZANDO…" : "GENERAR ANÁLISIS"}
              </button>
              {genError && <p className="mt-2 text-[11px] text-[var(--supply-red)]">{genError}</p>}
            </>
          ) : coachNow == null ? (
            <p className="text-[12px]" style={{ color: "rgba(242,230,196,0.7)" }}>
              El primer comentario llega en {fmtTime(comments[0].at_seconds)}.
            </p>
          ) : (
            <>
              <p
                className="font-data mb-1 text-[10px]"
                style={{ color: VERDICT_COLOR[coachNow.verdict] }}
              >
                {fmtTime(coachNow.at_seconds)} ·{" "}
                {coachNow.verdict === "good" ? "bien" : coachNow.verdict === "bad" ? "error" : "info"}
              </p>
              <p className="text-[12.5px] leading-[1.5]" style={{ color: "#f2e6c4" }}>
                {coachNow.text}
              </p>
            </>
          )}
          <Link
            href={`/chat?game=${data.id}&t=${fmtTime(seconds)}`}
            className="btn btn-gold mt-2 px-2.5 py-1 text-[10px] font-semibold tracking-[0.08em]"
            title="Abre el coach con este momento precargado"
          >
            PREGUNTAR
          </Link>
        </section>
      </aside>
    </div>
  );
}

/** One economy figure of the snapshot card. */
function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div>
      <p className="font-data text-[9px] font-medium tracking-[0.12em] text-[var(--ink-faint)]">
        {label}
      </p>
      <p className="font-data mt-0.5 text-[20px] font-semibold leading-none" style={{ color }}>
        {value}
      </p>
      <p className="font-data mt-1 text-[9.5px] text-[var(--ink-faint)]">{sub}</p>
    </div>
  );
}

/** Tiny APM history up to the playhead, right of the live number. */
function ApmSpark({
  series,
  uiFrame,
  frames,
}: {
  series?: Float64Array;
  uiFrame: number;
  frames: number;
}) {
  if (!series) return null;
  const upto = Math.max(2, Math.min(series.length, Math.ceil((uiFrame / frames) * series.length)));
  const max = Math.max(1, ...Array.from(series.subarray(0, upto)));
  const pts = Array.from(series.subarray(0, upto))
    .map((v, i) => `${(i / (upto - 1)) * 120},${18 - (v / max) * 16}`)
    .join(" ");
  return (
    <svg viewBox="0 0 120 20" width="120" height="20" className="ml-auto block">
      <polyline points={pts} fill="none" stroke="var(--psi)" strokeWidth="1.5" />
    </svg>
  );
}

/** "Momento m:ss" row + the player picker that drives the whole right column. */
function MomentHeader({
  players,
  focus,
  seconds,
  myTeam,
  showTeams,
  onPick,
}: {
  players: ViewerData["players"];
  focus: ViewerData["players"][number];
  seconds: number;
  myTeam: number | null;
  showTeams: boolean;
  onPick: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="hud-label">Momento {fmtTime(seconds)}</span>
      <div className="relative ml-auto">
        <button
          onClick={() => setOpen((v) => !v)}
          className="font-data flex min-w-[186px] cursor-pointer items-center gap-2 border px-2 py-1.5 text-[11px] font-semibold"
          style={{
            background: "rgba(4,10,8,0.85)",
            borderColor: open ? "var(--gold-line)" : "rgba(84,232,150,0.35)",
          }}
        >
          <span className="h-[9px] w-[9px] flex-none" style={{ background: focus.color }} />
          <span className="flex-1 truncate text-left">{focus.name}</span>
          <span className="text-[9.5px] text-[var(--ink-faint)]">
            {RACE_LETTER[focus.race] ?? "?"}
          </span>
          <span className="text-[9px] text-[var(--gold)]">▼</span>
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div
              className="absolute right-0 top-full z-20 mt-1 flex w-[236px] flex-col border p-1 backdrop-blur-[12px]"
              style={{
                background: "rgba(5,12,10,0.97)",
                borderColor: "var(--gold-line)",
                boxShadow: "0 14px 34px rgba(0,0,0,0.55)",
              }}
            >
              {players.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onPick(p.id);
                    setOpen(false);
                  }}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-[11.5px] hover:bg-[var(--psi-dim)]"
                  style={{
                    borderLeft: `2px solid ${p.color}`,
                    background: p.id === focus.id ? "var(--hud)" : "transparent",
                    color: p.id === focus.id ? "var(--ink)" : "var(--ink-dim)",
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="font-data text-[9.5px] text-[var(--ink-faint)]">
                    {RACE_LETTER[p.race] ?? "?"}
                  </span>
                  <span
                    className="font-data w-[52px] text-right text-[8.5px] font-semibold tracking-[0.1em]"
                    style={{ color: "var(--gold)" }}
                  >
                    {p.isMe ? "TÚ" : showTeams ? (p.team === myTeam ? "ALIADO" : `EQ ${p.team}`) : ""}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
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
        background: "rgba(4,10,8,0.94)",
      }}
    >
      {info.rows.map((r, i) => (
        <p key={i} className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="h-[7px] w-[7px] shrink-0" style={{ background: r.color }} />
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

  const pct = `${(uiFrame / data.frames) * 100}%`;

  return (
    <div
      className="border px-3 pb-2.5 pt-2 backdrop-blur-[8px]"
      style={{
        borderColor: "rgba(84,232,150,0.24)",
        background: "linear-gradient(180deg, rgba(9,26,20,0.8), rgba(6,16,13,0.7))",
      }}
    >
      {/* Marker lane */}
      <div className="relative -mx-3 mb-0.5 h-[15px]">
        {markers.map((m, i) => (
          <button
            key={i}
            onClick={() => onSeek(m.f)}
            title={`${fmtTime(Math.round(m.f / FPS))} — ${m.label}`}
            className="absolute -translate-x-1/2 cursor-pointer text-[9px] leading-none"
            style={{
              left: `${(m.f / data.frames) * 100}%`,
              color: m.comment
                ? VERDICT_COLOR[m.comment.verdict]
                : m.kind === "battle"
                  ? "var(--supply-red)"
                  : m.kind === "coach"
                    ? "var(--gold)"
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

      {/* Scrub bar — full-bleed band, gold playhead */}
      <div
        ref={barRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFromEvent(e.clientX);
        }}
        className="relative -mx-3 h-[12px] cursor-pointer border-y"
        style={{ background: "rgba(84,232,150,0.1)", borderColor: "rgba(84,232,150,0.18)" }}
      >
        <div
          className="pointer-events-none absolute inset-y-0 left-0"
          style={{
            width: pct,
            background: "linear-gradient(90deg, rgba(84,232,150,0.18), rgba(84,232,150,0.32))",
          }}
        />
        <div
          className="pointer-events-none absolute -inset-y-[3px] w-[3px] -translate-x-1/2"
          style={{ left: pct, background: "var(--gold)", boxShadow: "0 0 8px rgba(255,207,63,0.8)" }}
        />
      </div>

      {/* Transport */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <button
          className="font-data cursor-pointer border px-3.5 py-1.5 text-[11px] font-semibold tracking-[0.1em]"
          style={{
            background: "var(--gold-dim)",
            borderColor: "rgba(255,207,63,0.55)",
            color: "var(--gold)",
          }}
          onClick={onToggle}
        >
          {playing ? "⏸ PAUSA" : "▶ PLAY"}
        </button>
        <span className="font-data text-[15px] font-semibold tabular-nums">
          {fmtTime(Math.floor(uiFrame / FPS))}
          <span className="font-normal text-[var(--ink-faint)]"> / {fmtTime(data.durationSeconds)}</span>
        </span>
        <span className="font-data hidden text-[10px] text-[var(--ink-faint)] sm:inline">
          clic en la barra para saltar
        </span>
        {resimOn && (
          <span
            className="font-data px-1.5 py-0.5 text-[10px]"
            style={{ background: "var(--psi-dim)", color: "var(--psi)" }}
            title="Unidades, economía y bajas vienen de la re-simulación OpenBW, no de los comandos"
          >
            Simulación completa
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => onSpeed(s)}
              className={`chip ${s === speed ? "chip-on" : ""}`}
              style={{ fontSize: 11, textTransform: "none" }}
            >
              {s}×
            </button>
          ))}
          <button
            onClick={onToggleTech}
            className={`chip ml-1 ${showTech ? "chip-on" : ""}`}
            style={{ fontSize: 11, textTransform: "none" }}
            title="Mostrar marcadores de upgrades y tech"
          >
            ▲ tech
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The whole game, one metric at a time, for every player — under the player
 * and synced to it: the gold playhead is the same instant the board shows,
 * and clicking anywhere in the plot moves both.
 */
function HistoryPanel({
  data,
  series,
  hasResim,
  uiFrame,
  focusId,
  myTeam,
  showTeams,
  teamOrder,
  onSeek,
}: {
  data: ViewerData;
  series: Map<number, Partial<Record<MetricKey, Float64Array>>>;
  hasResim: boolean;
  uiFrame: number;
  focusId: number;
  myTeam: number | null;
  showTeams: boolean;
  teamOrder: number[];
  onSeek: (f: number) => void;
}) {
  const available = METRICS.filter((m) => !m.resim || hasResim);
  // Layer B may arrive after mount: the default metric is derived, so it
  // upgrades from APM to supply on its own unless the user already picked one.
  const [picked, setMetric] = useState<MetricKey | null>(null);
  const [view, setView] = useState<ViewMode>(showTeams ? "teams" : "all");
  const [type, setType] = useState<ChartType>("line");
  const plotRef = useRef<HTMLDivElement>(null);

  const active: MetricKey =
    picked && available.some((m) => m.key === picked) ? picked : hasResim ? "sup" : "apm";
  const meta = METRICS.find((m) => m.key === active)!;

  // What gets drawn: one entry per line, already bucketed.
  const lines = useMemo(() => {
    const out: {
      name: string;
      color: string;
      values: Float64Array;
      width: number;
      opacity: number;
      dash?: string;
    }[] = [];
    const get = (pid: number) => series.get(pid)?.[active];

    if (view === "teams" && showTeams) {
      for (const team of teamOrder) {
        const roster = data.players.filter((p) => p.team === team);
        const sum = new Float64Array(BUCKETS);
        for (const p of roster) {
          const v = get(p.id);
          if (v) for (let b = 0; b < BUCKETS; b++) sum[b] += v[b];
        }
        // Rolling-window ratios average across the roster instead of summing
        // into a fake number.
        if ((active === "apm" || active === "hk") && roster.length > 0)
          for (let b = 0; b < BUCKETS; b++) sum[b] = Math.round(sum[b] / roster.length);
        const mine = team === myTeam;
        out.push({
          name: mine ? "Tu equipo" : `Equipo ${team}`,
          color: mine ? (roster.find((p) => p.isMe)?.color ?? "var(--psi)") : roster[0]?.color ?? "#9aa8bb",
          values: sum,
          width: mine ? 2.2 : 1.6,
          opacity: 1,
        });
      }
      return out;
    }

    for (const p of data.players) {
      const v = get(p.id);
      if (!v) continue;
      const isFocus = p.id === focusId;
      out.push({
        name: p.name,
        color: p.color,
        values: v,
        width: view === "focus" ? (isFocus ? 2.4 : 1.2) : p.isMe ? 2 : 1.4,
        opacity: view === "focus" ? (isFocus ? 1 : 0.28) : 0.9,
      });
    }
    // The highlighted line draws last, on top of the dimmed pack.
    if (view === "focus") out.sort((a, b) => a.opacity - b.opacity);
    return out;
  }, [series, active, view, showTeams, teamOrder, data.players, myTeam, focusId]);

  const yMax = useMemo(() => {
    let max = 1;
    for (const ln of lines) for (let b = 0; b < BUCKETS; b++) if (ln.values[b] > max) max = ln.values[b];
    // Round up to a friendly ceiling so the axis labels read clean.
    const mag = Math.pow(10, Math.floor(Math.log10(max)));
    return Math.ceil(max / mag) * mag;
  }, [lines]);

  const curBucket = Math.min(
    BUCKETS - 1,
    Math.max(0, Math.floor((uiFrame / Math.max(1, data.frames)) * BUCKETS))
  );
  const headPct = `${(uiFrame / Math.max(1, data.frames)) * 100}%`;

  const seekFromEvent = (clientX: number) => {
    const el = plotRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0) onSeek(((clientX - r.left) / r.width) * data.frames);
  };

  const toPts = (v: Float64Array) =>
    Array.from(v)
      .map((y, b) => `${((b + 0.5) / BUCKETS) * 1000},${150 - (y / yMax) * 142}`)
      .join(" ");

  // Bars: BUCKETS collapsed into BAR_GROUPS side-by-side groups.
  const bars = useMemo(() => {
    if (type !== "bars") return null;
    const per = Math.floor(BUCKETS / BAR_GROUPS);
    return Array.from({ length: BAR_GROUPS }, (_, g) => ({
      past: ((g + 0.5) / BAR_GROUPS) * data.frames <= uiFrame,
      vals: lines.map((ln) => {
        let sum = 0;
        for (let b = g * per; b < (g + 1) * per; b++) sum += ln.values[b];
        return { color: ln.color, opacity: ln.opacity, h: (sum / per / yMax) * 100 };
      }),
    }));
  }, [type, lines, yMax, uiFrame, data.frames]);

  const q = (n: number) => fmtTime(Math.floor((n / 4) * data.durationSeconds));

  return (
    <div className="card px-0 pb-2.5 pt-2.5">
      {/* Header: scope + chart type */}
      <div className="mx-3 mb-2 flex flex-wrap items-center gap-2">
        <span className="hud-label">Historia completa · todos los jugadores</span>
        <span className="ml-1 flex gap-1">
          {showTeams && (
            <button
              className={`chip ${view === "teams" ? "chip-on" : ""}`}
              onClick={() => setView("teams")}
            >
              Equipos
            </button>
          )}
          <button className={`chip ${view === "all" ? "chip-on" : ""}`} onClick={() => setView("all")}>
            {data.players.length} jugadores
          </button>
          <button
            className={`chip ${view === "focus" ? "chip-on" : ""}`}
            onClick={() => setView("focus")}
          >
            Destacar selección
          </button>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <span className="font-data text-[9.5px] text-[var(--ink-ghost)]">GRÁFICO</span>
          {(
            [
              ["line", "Línea"],
              ["area", "Área"],
              ["bars", "Barras"],
            ] as [ChartType, string][]
          ).map(([t, label]) => (
            <button key={t} className={`chip ${type === t ? "chip-on" : ""}`} onClick={() => setType(t)}>
              {label}
            </button>
          ))}
        </span>
      </div>

      {/* Metric picker */}
      <div className="mx-3 mb-2 flex flex-wrap gap-1">
        {available.map((m) => (
          <button
            key={m.key}
            className={`chip ${m.key === active ? "chip-on" : ""}`}
            style={
              m.key === active
                ? undefined
                : { borderColor: "var(--grid-line-soft)", color: "var(--ink-faint)" }
            }
            onClick={() => setMetric(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Selected metric + legend with the value at the playhead */}
      <div className="mx-3 mb-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-[12.5px] font-semibold">{meta.label}</span>
        <span className="font-data text-[9.5px] text-[var(--ink-faint)]">{meta.unit}</span>
        <span className="ml-auto flex flex-wrap justify-end gap-x-3 gap-y-0.5">
          {lines.map((ln) => (
            <span
              key={ln.name}
              className="font-data flex items-center gap-1.5 text-[10px]"
              style={{ color: "rgba(223,250,234,0.62)", opacity: Math.max(0.5, ln.opacity) }}
            >
              <span className="h-[2px] w-[12px]" style={{ background: ln.color }} />
              {ln.name}
              <span className="font-semibold text-[var(--ink)]">
                {Math.round(ln.values[curBucket])}
              </span>
            </span>
          ))}
        </span>
      </div>

      {/* The plot — clicking it is the same as clicking the scrub bar */}
      <div
        ref={plotRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFromEvent(e.clientX);
        }}
        className="relative h-[150px] cursor-pointer touch-none border-y"
        style={{ borderTopColor: "var(--grid-line-soft)", borderBottomColor: "var(--grid-line)" }}
      >
        <div
          className="pointer-events-none absolute left-0 right-0 top-1/2 h-px"
          style={{ background: "rgba(84,232,150,0.08)" }}
        />
        <span className="font-data pointer-events-none absolute left-[5px] top-[3px] z-[2] text-[9px] text-[var(--ink-faint)]">
          {yMax}
        </span>
        <span className="font-data pointer-events-none absolute left-[5px] top-1/2 z-[2] text-[9px] text-[var(--ink-ghost)]">
          {Math.round(yMax / 2)}
        </span>

        {type !== "bars" ? (
          <svg viewBox="0 0 1000 150" preserveAspectRatio="none" width="100%" height="150" className="block">
            {type === "area" &&
              lines.map((ln) => (
                <polygon
                  key={`a-${ln.name}`}
                  points={`0,150 ${toPts(ln.values)} 1000,150`}
                  fill={ln.color}
                  opacity={0.16 * ln.opacity}
                />
              ))}
            {lines.map((ln) => (
              <polyline
                key={ln.name}
                points={toPts(ln.values)}
                fill="none"
                stroke={ln.color}
                strokeWidth={ln.width}
                strokeDasharray={ln.dash}
                opacity={ln.opacity}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        ) : (
          <div className="absolute inset-0 flex items-end gap-[7px] px-[5px]">
            {bars!.map((bk, i) => (
              <div
                key={i}
                className="flex h-full flex-1 items-end gap-px"
                style={{ opacity: bk.past ? 1 : 0.45 }}
              >
                {bk.vals.map((v, j) => (
                  <div
                    key={j}
                    className="flex-1"
                    style={{ background: v.color, height: `${v.h}%`, opacity: v.opacity }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Playhead, shared with the board */}
        <div
          className="pointer-events-none absolute inset-y-0 z-[3] w-[2px]"
          style={{ left: headPct, background: "var(--gold)", boxShadow: "0 0 8px rgba(255,207,63,0.8)" }}
        />
        <div
          className="font-data pointer-events-none absolute top-[2px] z-[4] -translate-x-1/2 whitespace-nowrap border px-[5px] text-[9.5px] font-semibold"
          style={{
            left: headPct,
            color: "var(--gold)",
            background: "rgba(8,18,14,0.9)",
            borderColor: "var(--gold-line)",
          }}
        >
          {fmtTime(Math.floor(uiFrame / FPS))}
        </div>
      </div>

      {/* Time axis */}
      <div className="font-data mx-3 mt-1 flex justify-between text-[9px] text-[var(--ink-ghost)]">
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n}>{q(n)}</span>
        ))}
      </div>
    </div>
  );
}
