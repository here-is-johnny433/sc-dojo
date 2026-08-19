"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  Cell,
} from "recharts";

interface MonthRow {
  month: string;
  games: number;
  winrate_pct: number | null;
  avg_apm: number | null;
  avg_eapm: number | null;
}

const axisStyle = {
  fontSize: 10,
  fontFamily: "var(--font-plex-mono)",
  fill: "var(--ink-faint)",
};

function fmtMonth(m: string): string {
  const d = new Date(m);
  return d.toLocaleDateString("es", { month: "short" });
}

function TooltipBox({ label, rows }: { label: string; rows: [string, string][] }) {
  return (
    <div className="card px-3 py-2 text-[11px]" style={{ background: "var(--hud)" }}>
      <p className="font-data mb-0.5 text-[var(--ink-faint)]">{label}</p>
      {rows.map(([k, v]) => (
        <p key={k} className="font-data text-[var(--ink)]">
          {k}: <span className="font-semibold">{v}</span>
        </p>
      ))}
    </div>
  );
}

export function ApmTrend({ data }: { data: MonthRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
        <XAxis dataKey="month" tickFormatter={fmtMonth} tick={axisStyle} axisLine={false} tickLine={false} />
        <YAxis tick={axisStyle} axisLine={false} tickLine={false} width={46} />
        <Tooltip
          cursor={{ stroke: "var(--grid-line-strong)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                label={fmtMonth(payload[0].payload.month)}
                rows={[
                  ["APM", String(payload[0].payload.avg_apm ?? "—")],
                  ["EAPM", String(payload[0].payload.avg_eapm ?? "—")],
                  ["Partidas", String(payload[0].payload.games)],
                ]}
              />
            ) : null
          }
        />
        <Line isAnimationActive={false} type="monotone" dataKey="avg_apm" stroke="var(--psi)" strokeWidth={2} dot={{ r: 3, fill: "var(--psi)", strokeWidth: 0 }} />
        <Line isAnimationActive={false} type="monotone" dataKey="avg_eapm" stroke="var(--ink-faint)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function WinrateTrend({ data }: { data: MonthRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
        <XAxis dataKey="month" tickFormatter={fmtMonth} tick={axisStyle} axisLine={false} tickLine={false} />
        <YAxis domain={[0, 100]} tick={axisStyle} axisLine={false} tickLine={false} width={46} />
        <Tooltip
          cursor={{ fill: "var(--grid-line-soft)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                label={fmtMonth(payload[0].payload.month)}
                rows={[
                  ["Winrate", `${payload[0].payload.winrate_pct ?? "—"}%`],
                  ["Partidas", String(payload[0].payload.games)],
                ]}
              />
            ) : null
          }
        />
        <Bar isAnimationActive={false} dataKey="winrate_pct" radius={[3, 3, 0, 0]} maxBarSize={26}>
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={(d.winrate_pct ?? 0) >= 50 ? "var(--vespene)" : "var(--supply-red)"}
              fillOpacity={0.75}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
