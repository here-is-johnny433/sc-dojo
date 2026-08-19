// Builds the compact package the replay viewer streams: everything the canvas
// and the sidebar need, derived from the parsed screp JSON of a game.
//
// Coordinate units in screp differ per command and are easy to get wrong:
//   · Header.MapWidth/MapHeight  → tiles (×32 = pixels)
//   · Build / Land   .Pos        → TILES
//   · Right Click / Targeted Order / Minimap Ping / MapData.* → PIXELS
// Everything below is normalized to pixels.

import fs from "fs/promises";
import { db } from "./db";
import { FPS, RESOURCE_DEPOTS } from "./bw";

export const ORDER_MOVE = 0;
export const ORDER_ATTACK = 1;
export const ORDER_CAST = 2;

export interface ViewerPlayer {
  id: number;
  name: string;
  race: string;
  team: number;
  color: string; // hex, lightened so it reads on the dark board
  isMe: boolean;
  start: [number, number] | null;
}

export interface ViewerMap {
  name: string;
  tileset: string;
  widthPx: number;
  heightPx: number;
  minerals: number[]; // flat x,y pairs
  geysers: number[]; // flat x,y pairs
  starts: number[]; // flat x,y pairs
}

/** Production / build-order event. `x`,`y` present only for placed structures. */
export interface ViewerEvent {
  f: number;
  p: number;
  k: string; // Build | Land | Train | Unit Morph | Building Morph | Upgrade | Tech
  i: string;
  x?: number;
  y?: number;
}

export interface ViewerMarker {
  f: number;
  kind: "expansion" | "tech" | "battle" | "chat" | "leave";
  p: number | null;
  label: string;
}

export interface ViewerData {
  id: string;
  frames: number;
  durationSeconds: number;
  fps: number;
  map: ViewerMap;
  players: ViewerPlayer[];
  events: ViewerEvent[];
  /** stride 4: frame, x, y, playerId + kind*16 */
  orders: number[];
  /** stride 3: frame, x, y (player is folded into the marker list instead) */
  pings: number[];
  chat: { f: number; p: number; msg: string }[];
  leaves: { f: number; p: number }[];
  markers: ViewerMarker[];
  /** playerId → sorted frames of every command, for rolling APM */
  actions: Record<number, number[]>;
}

interface RawCmd {
  Frame: number;
  PlayerID: number;
  Type: { Name: string };
  Pos?: { X: number; Y: number };
  Unit?: { Name: string };
  Order?: { Name: string };
  Upgrade?: { Name: string };
  Tech?: { Name: string };
  Message?: string;
  SenderSlotID?: number;
}

interface RawPlayer {
  ID: number;
  SlotID: number;
  Name: string;
  Team: number;
  Observer: boolean;
  Race?: { Name: string };
  Color?: { RGB: number };
}

interface RawReplay {
  Header: {
    Frames: number;
    MapWidth: number;
    MapHeight: number;
    Map?: string;
    Players: RawPlayer[];
  };
  Commands: { Cmds: RawCmd[] };
  MapData?: {
    Name?: string;
    TileSet?: { Name: string };
    MineralFields?: { X: number; Y: number }[];
    Geysers?: { X: number; Y: number }[];
    StartLocations?: { X: number; Y: number }[];
  };
  Computed?: {
    ChatCmds?: RawCmd[];
    LeaveGameCmds?: RawCmd[];
    PlayerDescs?: { PlayerID: number; StartLocation?: { X: number; Y: number } }[];
  };
}

function rgbToHsl(rgb: number): { h: number; s: number; l: number } {
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const chan = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hex = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v * 255)))
      .toString(16)
      .padStart(2, "0");
  const hh = h / 360;
  return `#${hex(chan(hh + 1 / 3))}${hex(chan(hh))}${hex(chan(hh - 1 / 3))}`;
}

const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// In-game colors are authentic but several are too dark on --void, and lifting
// them collapses pairs like Yellow/Olive — so nudge the hue when two collide.
function assignColors(rgbs: number[]): string[] {
  const used: number[] = [];
  return rgbs.map((rgb) => {
    const { h, s, l } = rgbToHsl(rgb);
    const L = Math.min(0.78, Math.max(0.6, l));
    const S = s > 0.04 ? Math.max(0.55, s) : s; // greys stay grey
    let hue = h;
    if (S > 0.2) {
      for (let i = 0; i < 6 && used.some((u) => hueGap(hue, u) < 18); i++) hue = (hue + 30) % 360;
      used.push(hue);
    }
    return hslToHex(hue, S, L);
  });
}

function orderKind(name: string): number {
  if (name.includes("Attack")) return ORDER_ATTACK;
  if (name.startsWith("Cast")) return ORDER_CAST;
  return ORDER_MOVE;
}

// Attack orders bunch up when armies meet: windows well above the game's own
// baseline become battle markers on the timeline.
function battleMarkers(attacks: number[], frames: number): ViewerMarker[] {
  const WINDOW = Math.round(FPS * 20);
  const buckets = new Map<number, number>();
  for (const f of attacks) {
    const b = Math.floor(f / WINDOW);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  if (buckets.size === 0) return [];
  const counts = [...buckets.values()].sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  const threshold = Math.max(4, median * 3);
  const hot = [...buckets.entries()]
    .filter(([, c]) => c >= threshold)
    .sort((a, b) => a[0] - b[0]);

  // Merge adjacent windows into one battle, keep the busiest ones.
  const merged: { from: number; to: number; count: number }[] = [];
  for (const [b, c] of hot) {
    const last = merged[merged.length - 1];
    if (last && b === last.to + 1) {
      last.to = b;
      last.count += c;
    } else merged.push({ from: b, to: b, count: c });
  }
  return merged
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
    .map((m) => ({
      f: Math.min(frames, Math.round(((m.from + m.to + 1) / 2) * WINDOW)),
      kind: "battle" as const,
      p: null,
      label: `${m.count} órdenes de ataque`,
    }))
    .sort((a, b) => a.f - b.f);
}

export async function buildViewerData(gameId: string): Promise<ViewerData | null> {
  const g = await db().query(
    "SELECT id, frames, duration_seconds, map_name, json_path FROM games WHERE id = $1",
    [gameId]
  );
  if (!g.rowCount || !g.rows[0].json_path) return null;
  const game = g.rows[0];

  const raw = JSON.parse(await fs.readFile(game.json_path, "utf8")) as RawReplay;
  const mine = await db().query(
    "SELECT player_id FROM game_players WHERE game_id = $1 AND is_me",
    [gameId]
  );
  const myIds = new Set<number>(mine.rows.map((r) => r.player_id));

  const startByPlayer = new Map<number, [number, number]>();
  for (const d of raw.Computed?.PlayerDescs ?? []) {
    if (d.StartLocation) startByPlayer.set(d.PlayerID, [d.StartLocation.X, d.StartLocation.Y]);
  }

  const rawPlayers = (raw.Header.Players ?? []).filter((p) => !p.Observer);
  const colors = assignColors(rawPlayers.map((p) => p.Color?.RGB ?? 0x9aa8bb));
  const players: ViewerPlayer[] = rawPlayers.map((p, i) => ({
    id: p.ID,
    name: p.Name,
    race: p.Race?.Name ?? "?",
    team: p.Team,
    color: colors[i],
    isMe: myIds.has(p.ID),
    start: startByPlayer.get(p.ID) ?? null,
  }));
  const known = new Set(players.map((p) => p.id));
  const slotToPlayer = new Map(rawPlayers.map((p) => [p.SlotID, p.ID]));

  const events: ViewerEvent[] = [];
  const orders: number[] = [];
  const pings: number[] = [];
  const actions: Record<number, number[]> = {};
  const attackFrames: number[] = [];
  const firstAttack = new Map<number, number>();
  for (const p of players) actions[p.id] = [];

  for (const c of raw.Commands?.Cmds ?? []) {
    if (!known.has(c.PlayerID)) continue;
    actions[c.PlayerID].push(c.Frame);

    switch (c.Type.Name) {
      case "Build":
      case "Land":
        if (c.Pos && c.Unit) {
          events.push({
            f: c.Frame,
            p: c.PlayerID,
            k: c.Type.Name,
            i: c.Unit.Name,
            x: c.Pos.X * 32 + 16,
            y: c.Pos.Y * 32 + 16,
          });
        }
        break;
      case "Train":
      case "Unit Morph":
      case "Building Morph":
        if (c.Unit) events.push({ f: c.Frame, p: c.PlayerID, k: c.Type.Name, i: c.Unit.Name });
        break;
      case "Upgrade":
        if (c.Upgrade) events.push({ f: c.Frame, p: c.PlayerID, k: "Upgrade", i: c.Upgrade.Name });
        break;
      case "Tech":
        if (c.Tech) events.push({ f: c.Frame, p: c.PlayerID, k: "Tech", i: c.Tech.Name });
        break;
      case "Right Click":
        if (c.Pos) orders.push(c.Frame, c.Pos.X, c.Pos.Y, c.PlayerID + ORDER_MOVE * 16);
        break;
      case "Targeted Order": {
        const name = c.Order?.Name ?? "";
        if (!c.Pos || name.startsWith("RallyPoint")) break;
        const kind = orderKind(name);
        orders.push(c.Frame, c.Pos.X, c.Pos.Y, c.PlayerID + kind * 16);
        if (kind === ORDER_ATTACK) {
          attackFrames.push(c.Frame);
          if (!firstAttack.has(c.PlayerID)) firstAttack.set(c.PlayerID, c.Frame);
        }
        break;
      }
      case "Minimap Ping":
        if (c.Pos) pings.push(c.Frame, c.Pos.X, c.Pos.Y);
        break;
    }
  }
  events.sort((a, b) => a.f - b.f);

  // Chat carries the real sender in SenderSlotID; PlayerID is unreliable there.
  const chat = (raw.Computed?.ChatCmds ?? []).map((c) => ({
    f: c.Frame,
    p: slotToPlayer.get(c.SenderSlotID ?? -1) ?? c.PlayerID,
    msg: c.Message ?? "",
  }));
  const leaves = (raw.Computed?.LeaveGameCmds ?? [])
    .filter((c) => known.has(c.PlayerID))
    .map((c) => ({ f: c.Frame, p: c.PlayerID }));

  const nameOf = new Map(players.map((p) => [p.id, p.name]));
  const markers: ViewerMarker[] = [];
  for (const e of events) {
    if ((e.k === "Build" || e.k === "Building Morph") && RESOURCE_DEPOTS.has(e.i)) {
      markers.push({ f: e.f, kind: "expansion", p: e.p, label: `${nameOf.get(e.p)}: ${e.i}` });
    } else if (e.k === "Upgrade" || e.k === "Tech") {
      markers.push({ f: e.f, kind: "tech", p: e.p, label: `${nameOf.get(e.p)}: ${e.i}` });
    }
  }
  for (const c of chat) {
    markers.push({ f: c.f, kind: "chat", p: c.p, label: `${nameOf.get(c.p) ?? "?"}: ${c.msg}` });
  }
  for (const l of leaves) {
    markers.push({ f: l.f, kind: "leave", p: l.p, label: `${nameOf.get(l.p)} abandonó` });
  }
  for (const [p, f] of firstAttack) {
    markers.push({ f, kind: "battle", p, label: `${nameOf.get(p)}: primer ataque` });
  }
  markers.push(...battleMarkers(attackFrames, raw.Header.Frames));
  markers.sort((a, b) => a.f - b.f);

  const flat = (pts?: { X: number; Y: number }[]) =>
    (pts ?? []).flatMap((p) => [p.X, p.Y]);

  return {
    id: game.id,
    frames: raw.Header.Frames ?? game.frames ?? 0,
    durationSeconds: game.duration_seconds ?? Math.round((raw.Header.Frames ?? 0) / FPS),
    fps: FPS,
    map: {
      name: game.map_name ?? raw.MapData?.Name ?? raw.Header.Map ?? "",
      tileset: raw.MapData?.TileSet?.Name ?? "",
      widthPx: (raw.Header.MapWidth ?? 128) * 32,
      heightPx: (raw.Header.MapHeight ?? 128) * 32,
      minerals: flat(raw.MapData?.MineralFields),
      geysers: flat(raw.MapData?.Geysers),
      starts: flat(raw.MapData?.StartLocations),
    },
    players,
    events,
    orders,
    pings,
    chat,
    leaves,
    markers,
    actions,
  };
}
