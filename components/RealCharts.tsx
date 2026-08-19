"use client";

// The "real data" block of the game page: everything here comes from the OpenBW
// re-simulation (banked resources, supply, live army) or straight from the
// commands (hotkeys) — nothing is inferred from build-order events.
//
// Recharts note: isAnimationActive={false} on EVERY series. Animated series in
// this app flicker on re-render and make the tooltip lag behind the cursor.

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  LineChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceArea,
  ReferenceDot,
} from "recharts";
import type { GameSeries, SeriesPoint } from "@/lib/game-series";

// Same family as the unit colors of the estimated charts, so the page reads as
// one palette. Index = position in the player list.
const PLAYER_COLORS = [
  "#35d0ba", "#4da3ff", "#ecc35b", "#b07fe0", "#e0a93e",
  "#58c26e", "#e25555", "#7ea6d6", "#d55181", "#9aa8bb",
];

const fmt = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

const axisTick = {
  fontSize: 10,
  fontFamily: "var(--font-plex-mono)",
  fill: "var(--ink-faint)",
};

// Recharts inspects its direct children by component type, so the shared time
// axis is a props bag to spread — never a wrapper component.
const timeAxis = (duration: number) => {
  // Whole-minute ticks, so the last one never lands on top of its neighbour.
  const step = Math.max(1, Math.ceil(duration / 60 / 8));
  const ticks: number[] = [];
  for (let m = 0; m * 60 <= duration; m += step) ticks.push(m * 60);
  return {
    dataKey: "t",
    type: "number" as const,
    domain: [0, Math.max(1, duration)],
    ticks,
    tickFormatter: (t: number) => `${Math.round(t / 60)}'`,
    tick: axisTick,
    axisLine: false,
    tickLine: false,
  };
};

function Card({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
          {title}
        </h3>
        {right ?? (hint && <p className="text-[11px] text-[var(--ink-faint)]">{hint}</p>)}
      </div>
      {children}
    </section>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div className="card px-3 py-2 text-[11px]" style={{ background: "var(--hud)" }}>
      {children}
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span
      className="font-data rounded-md px-2 py-0.5 text-[10px]"
      style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}
    >
      {children}
    </span>
  );
}

export function RealCharts({ series }: { series: GameSeries }) {
  const { players, durationSeconds: duration, hasResim } = series;
  const me = players.find((p) => p.isMe) ?? players[0];
  const [focusId, setFocusId] = useState<number>(me?.id ?? 0);
  const focus = players.find((p) => p.id === focusId) ?? me;
  const colorOf = (id: number) =>
    PLAYER_COLORS[Math.max(0, players.findIndex((p) => p.id === id)) % PLAYER_COLORS.length];

  const peak = series.peaks[focusId];
  const blocks = series.blocks[focusId];
  const groups = series.hotkeyGroups[focusId] ?? [];

  // Hotkey chart: the focused player against the average of everyone else, so a
  // low ratio reads as "low for this lobby" and not just "low in the abstract".
  const hotkeyData = useMemo(
    () =>
      series.hotkeys.map((row: SeriesPoint) => {
        const others = players
          .filter((p) => p.id !== focusId)
          .map((p) => row[`h${p.id}`])
          .filter((v): v is number => v != null);
        return {
          t: row.t,
          me: row[`h${focusId}`] ?? null,
          others: others.length
            ? Math.round((others.reduce((s, v) => s + v, 0) / others.length) * 10) / 10
            : null,
        };
      }),
    [series.hotkeys, players, focusId]
  );

  if (!focus) return null;

  const selector = (
    <div className="flex flex-wrap items-center gap-1.5">
      {players.map((p) => {
        const active = p.id === focusId;
        return (
          <button
            key={p.id}
            onClick={() => setFocusId(p.id)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors"
            style={{
              background: active ? "var(--hud-bright)" : "transparent",
              border: `1px solid ${active ? "var(--grid-line-strong)" : "transparent"}`,
              color: active ? "var(--ink)" : "var(--ink-faint)",
            }}
          >
            <span
              className="inline-block h-[8px] w-[8px] rounded-[2px]"
              style={{ background: colorOf(p.id) }}
            />
            {p.name}
            {p.isMe && <span className="text-[9px] uppercase text-[var(--psi)]">tú</span>}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-[11px] uppercase tracking-wider text-[var(--ink-faint)]">
          Jugador enfocado
        </p>
        {selector}
      </div>

      {hasResim && (
        <>
          {/* 1 — banked resources */}
          <Card
            title="Recursos en banco"
            right={
              peak ? (
                <p className="font-data text-[11px] text-[var(--ink-faint)]">
                  máx flotante:{" "}
                  <span style={{ color: "var(--minerals)" }}>{peak.minerals} min</span> a{" "}
                  {fmt(peak.mineralsSec)}
                  {peak.gas > 0 && (
                    <>
                      {" · "}
                      <span style={{ color: "var(--vespene)" }}>{peak.gas} gas</span> a{" "}
                      {fmt(peak.gasSec)}
                    </>
                  )}
                </p>
              ) : undefined
            }
          >
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={series.resources} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
                <XAxis {...timeAxis(duration)} />
                <YAxis
                  tick={axisTick}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))}
                />
                <Tooltip
                  cursor={{ stroke: "var(--grid-line-strong)" }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload as SeriesPoint;
                    return (
                      <Box>
                        <p className="font-data mb-1 text-[var(--ink-faint)]">{fmt(row.t)}</p>
                        <p className="font-data" style={{ color: "var(--minerals)" }}>
                          {row[`m${focusId}`] ?? "—"} minerales
                        </p>
                        <p className="font-data" style={{ color: "var(--vespene)" }}>
                          {row[`g${focusId}`] ?? "—"} gas
                        </p>
                      </Box>
                    );
                  }}
                />
                <Line
                  isAnimationActive={false}
                  type="monotone"
                  dataKey={`m${focusId}`}
                  stroke="var(--minerals)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
                <Line
                  isAnimationActive={false}
                  type="monotone"
                  dataKey={`g${focusId}`}
                  stroke="var(--vespene)"
                  strokeWidth={1.6}
                  strokeDasharray="5 4"
                  dot={false}
                  connectNulls
                />
                {peak && peak.minerals > 0 && (
                  <ReferenceDot
                    x={peak.mineralsSec}
                    y={peak.minerals}
                    r={3.5}
                    fill="var(--minerals)"
                    stroke="var(--void)"
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
            <p className="mt-1 text-[11px] text-[var(--ink-faint)]">
              — minerales · - - gas · el pico marca cuánto dejaste sin gastar
            </p>
          </Card>

          {/* 2 — supply and blocks */}
          <Card
            title="Supply y bloqueos"
            right={
              blocks ? (
                <Chip tone={blocks.totalSec > 0 ? "var(--supply-red)" : "var(--vespene)"}>
                  {blocks.totalSec > 0
                    ? `${blocks.totalSec}s bloqueado en ${blocks.blocks.length} momento${blocks.blocks.length === 1 ? "" : "s"}`
                    : "0s supply blocked ✓"}
                </Chip>
              ) : undefined
            }
          >
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={series.supply} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <XAxis {...timeAxis(duration)} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  cursor={{ stroke: "var(--grid-line-strong)" }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload as SeriesPoint;
                    const used = row[`u${focusId}`];
                    const max = row[`x${focusId}`];
                    return (
                      <Box>
                        <p className="font-data mb-1 text-[var(--ink-faint)]">{fmt(row.t)}</p>
                        <p className="font-data">
                          {used ?? "—"} / {max ?? "—"} supply
                        </p>
                        {used != null && max != null && used >= max && max < 200 && (
                          <p className="font-data" style={{ color: "var(--supply-red)" }}>
                            bloqueado
                          </p>
                        )}
                      </Box>
                    );
                  }}
                />
                {(blocks?.blocks ?? []).map((b, i) => (
                  <ReferenceArea
                    key={i}
                    x1={b.fromSec}
                    x2={b.toSec}
                    fill="var(--supply-red)"
                    fillOpacity={0.12}
                    stroke="none"
                  />
                ))}
                <Area
                  isAnimationActive={false}
                  type="monotone"
                  dataKey={`u${focusId}`}
                  stroke="var(--psi)"
                  strokeWidth={2}
                  fill="var(--psi)"
                  fillOpacity={0.14}
                  dot={false}
                  connectNulls
                />
                <Line
                  isAnimationActive={false}
                  type="stepAfter"
                  dataKey={`x${focusId}`}
                  stroke="var(--ink-ghost)"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  dot={false}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="mt-1 text-[11px] text-[var(--ink-faint)]">
              área = supply usado · - - tope · bandas rojas = bloqueado ≥5s
            </p>
          </Card>

          {/* 3 — living army supply, everybody at once */}
          <Card title="Ejército vivo" hint="supply de unidades vivas sin workers · quién va ganando">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={series.army} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <XAxis {...timeAxis(duration)} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  cursor={{ stroke: "var(--grid-line-strong)" }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload as SeriesPoint;
                    const rows = players
                      .map((p) => ({ p, v: row[`a${p.id}`] }))
                      .sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
                    return (
                      <Box>
                        <p className="font-data mb-1 text-[var(--ink-faint)]">{fmt(row.t)}</p>
                        {rows.map(({ p, v }) => (
                          <p key={p.id} className="font-data">
                            <span
                              className="mr-1.5 inline-block h-[8px] w-[8px] rounded-[2px]"
                              style={{ background: colorOf(p.id) }}
                            />
                            <span style={{ color: p.isMe ? "var(--ink)" : "var(--ink-dim)" }}>
                              {p.name}: {v ?? "—"}
                            </span>
                          </p>
                        ))}
                      </Box>
                    );
                  }}
                />
                {players.map((p) => {
                  const ally = me ? p.team === me.team : true;
                  return (
                    <Line
                      isAnimationActive={false}
                      key={p.id}
                      type="monotone"
                      dataKey={`a${p.id}`}
                      stroke={colorOf(p.id)}
                      strokeWidth={p.isMe ? 2.8 : 1.6}
                      strokeDasharray={ally ? undefined : "5 4"}
                      strokeOpacity={p.isMe ? 1 : 0.85}
                      dot={false}
                      connectNulls
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--ink-dim)]">
              {players.map((p) => (
                <span key={p.id} className="font-data inline-flex items-center gap-1">
                  <span
                    className="inline-block h-[8px] w-[8px] rounded-[2px]"
                    style={{ background: colorOf(p.id) }}
                  />
                  {p.name}
                  {me && p.team !== me.team && (
                    <span className="text-[var(--ink-faint)]">(rival)</span>
                  )}
                </span>
              ))}
            </div>
          </Card>
        </>
      )}

      {/* 4 — hotkeys (commands only: works with or without re-simulation) */}
      <Card title="Hotkeys" hint="% de acciones que fueron hotkeys · ventana móvil de 60s">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={hotkeyData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <XAxis {...timeAxis(duration)} />
            <YAxis
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              width={44}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              cursor={{ stroke: "var(--grid-line-strong)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as { t: number; me: number | null; others: number | null };
                return (
                  <Box>
                    <p className="font-data mb-1 text-[var(--ink-faint)]">{fmt(row.t)}</p>
                    <p className="font-data" style={{ color: "var(--psi)" }}>
                      {focus.name}: {row.me != null ? `${row.me}%` : "sin acciones"}
                    </p>
                    <p className="font-data text-[var(--ink-dim)]">
                      resto de la partida: {row.others != null ? `${row.others}%` : "—"}
                    </p>
                  </Box>
                );
              }}
            />
            <Line
              isAnimationActive={false}
              type="monotone"
              dataKey="others"
              stroke="var(--ink-ghost)"
              strokeWidth={1.4}
              strokeDasharray="4 4"
              dot={false}
              connectNulls
            />
            <Line
              isAnimationActive={false}
              type="monotone"
              dataKey="me"
              stroke="var(--psi)"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {groups.length === 0 && (
            <p className="text-[11px] text-[var(--ink-faint)]">
              {focus.name} no usó ningún grupo de control en esta partida.
            </p>
          )}
          {groups.map((g) => (
            <span
              key={g.group}
              className="font-data rounded-md border border-[var(--grid-line)] px-2 py-0.5 text-[10px] text-[var(--ink-dim)]"
            >
              <span style={{ color: "var(--psi)" }}>[{g.group}]</span> {g.assigns}{" "}
              {g.assigns === 1 ? "asignación" : "asignaciones"} · {g.uses}{" "}
              {g.uses === 1 ? "uso" : "usos"}
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
