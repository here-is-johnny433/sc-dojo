"use client";

// Score evolution of one player across games — one line per variable, fixed
// 0–10 axis so improvement is visible at a glance.

import { useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from "recharts";

export interface TrendPoint {
  game_id: string;
  label: string; // short date
  mechanics: number | null;
  economy: number | null;
  macro: number | null;
  combat: number | null;
  build: number | null;
  overall: number | null;
}

const SERIES: { key: keyof TrendPoint; label: string; color: string }[] = [
  { key: "overall", label: "Total", color: "var(--psi)" },
  { key: "mechanics", label: "Mecánica", color: "#4da3ff" },
  { key: "economy", label: "Economía", color: "#35d0ba" },
  { key: "macro", label: "Macro", color: "#ecc35b" },
  { key: "combat", label: "Combate", color: "#e25555" },
  { key: "build", label: "Build/Tech", color: "#b07fe0" },
];

const axisStyle = {
  fontSize: 10,
  fontFamily: "var(--font-plex-mono)",
  fill: "var(--ink-faint)",
};

export function ScoreTrend({ data }: { data: TrendPoint[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
        {SERIES.map((s) => (
          <button
            key={s.key}
            onClick={() => toggle(s.key)}
            className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors"
            style={
              hidden.has(s.key)
                ? { borderColor: "var(--grid-line)", color: "var(--ink-ghost)" }
                : { borderColor: "var(--grid-line-strong)", color: "var(--ink-dim)" }
            }
          >
            <span
              className="h-[7px] w-[7px] rounded-full"
              style={{ background: hidden.has(s.key) ? "var(--ink-ghost)" : s.color }}
            />
            {s.label}
          </button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -26 }}>
          <XAxis dataKey="label" tick={axisStyle} axisLine={false} tickLine={false} minTickGap={28} />
          <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={axisStyle} axisLine={false} tickLine={false} width={46} />
          <ReferenceLine y={5} stroke="var(--grid-line)" strokeDasharray="4 4" />
          <Tooltip
            cursor={{ stroke: "var(--grid-line-strong)" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="card px-3 py-2 text-[11px]" style={{ background: "var(--hud)" }}>
                  <p className="font-data mb-0.5 text-[var(--ink-faint)]">{label}</p>
                  {payload.map((e) => (
                    <p key={String(e.dataKey)} className="font-data" style={{ color: String(e.color) }}>
                      {SERIES.find((s) => s.key === e.dataKey)?.label}:{" "}
                      <span className="font-semibold">{e.value != null ? Number(e.value).toFixed(1) : "—"}</span>
                    </p>
                  ))}
                </div>
              ) : null
            }
          />
          {SERIES.filter((s) => !hidden.has(s.key)).map((s) => (
            <Line
              key={s.key}
              isAnimationActive={false}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={s.key === "overall" ? 2.5 : 1.5}
              strokeOpacity={s.key === "overall" ? 1 : 0.85}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
