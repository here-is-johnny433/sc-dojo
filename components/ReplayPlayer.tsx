"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { ViewerData, ViewerEvent } from "@/lib/viewer-data";

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
const PING_SECONDS = 2;
const CHAT_SECONDS = 9;
const DEFAULT_BUILD_SECONDS = 30;

// Very dark tileset tints — the board should stay behind the data.
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

export function ReplayPlayer({ gameId }: { gameId: string }) {
  const [data, setData] = useState<ViewerData | null>(null);
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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const buildListRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const dirtyRef = useRef(true);
  const drawRef = useRef<() => void>(undefined);

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

    // Terrain grid every 16 tiles.
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

    // Structures: fade in over their build time, expansions get a ring.
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
  }, [data]);

  useEffect(() => {
    drawRef.current = draw;
    dirtyRef.current = true;
  }, [draw]);

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
  const focus = data.players.find((p) => p.id === focusId) ?? data.players[0];
  const focusStats = stats.get(focus.id)!;
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
          >
            <canvas ref={canvasRef} className="h-full w-full rounded-md" />
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
              {data.players.map((p) => {
                const s = stats.get(p.id)!;
                return (
                  <tr
                    key={p.id}
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
                        color: s.workers < s.saturation * 0.8 ? "var(--energy)" : "var(--ink-dim)",
                      }}
                    >
                      {s.workers}
                    </td>
                    <td className="font-data text-right tabular-nums text-[var(--ink-dim)]">
                      {s.supply}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] leading-snug text-[var(--ink-faint)]">
            Wk = workers producidos vs. saturación ({focusStats.bases} base
            {focusStats.bases !== 1 ? "s" : ""} ≈ {focusStats.saturation}) · Sup = supply de
            ejército producido. Los replays guardan órdenes, no bajas.
          </p>
        </section>

        {/* Focused player */}
        <section className="card p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="h-[10px] w-[10px] rounded-[2px]" style={{ background: focus.color }} />
            <h3 className="truncate text-[13px] font-semibold">{focus.name}</h3>
          </div>

          <div className="mb-3">
            <div className="mb-1 flex justify-between text-[10px] text-[var(--ink-faint)]">
              <span>workers {focusStats.workers}</span>
              <span>saturación ~{focusStats.saturation}</span>
            </div>
            <div className="h-[5px] w-full overflow-hidden rounded-full bg-[var(--hud)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, (focusStats.workers / focusStats.saturation) * 100)}%`,
                  background:
                    focusStats.workers < focusStats.saturation * 0.8
                      ? "var(--energy)"
                      : "var(--psi)",
                }}
              />
            </div>
          </div>

          {focusStats.mix.length > 0 && (
            <div className="mb-3 space-y-0.5">
              {focusStats.mix.map(([unit, n]) => (
                <p key={unit} className="font-data flex justify-between text-[11px]">
                  <span className="truncate text-[var(--ink-dim)]">{unit}</span>
                  <span className="tabular-nums">{n}</span>
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

function Controls({
  data,
  uiFrame,
  playing,
  speed,
  showTech,
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
