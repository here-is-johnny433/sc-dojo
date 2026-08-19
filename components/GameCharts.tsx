"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Legend,
} from "recharts";

// Distinct series colors for unit types in the army mix (domain-tinted).
const UNIT_COLORS = [
  "#35d0ba", "#4da3ff", "#ecc35b", "#b07fe0", "#e0a93e",
  "#58c26e", "#e25555", "#7ea6d6", "#d55181", "#9aa8bb",
];

export interface ArmyMinute {
  minute: number;
  [unitOrPlayer: string]: number;
}

export function ArmyChart({
  data,
  myUnits,
  opponents,
}: {
  data: ArmyMinute[];
  myUnits: string[];   // unit type keys, stacked (my army mix)
  opponents: string[]; // player name keys, drawn as comparison lines
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <XAxis
          dataKey="minute"
          tickFormatter={(m) => `${m}'`}
          tick={{ fontSize: 10, fontFamily: "var(--font-plex-mono)", fill: "var(--ink-faint)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fontFamily: "var(--font-plex-mono)", fill: "var(--ink-faint)" }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          cursor={{ stroke: "var(--grid-line-strong)" }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as ArmyMinute;
            const mix = myUnits
              .map((u) => [u, row[u] ?? 0] as [string, number])
              .filter(([, v]) => v > 0);
            return (
              <div className="card px-3 py-2 text-[11px]" style={{ background: "var(--hud)" }}>
                <p className="font-data mb-1 text-[var(--ink-faint)]">minuto {label}</p>
                {mix.length === 0 && <p className="text-[var(--ink-faint)]">sin ejército aún</p>}
                {mix.map(([u, v]) => (
                  <p key={u} className="font-data">
                    <span
                      className="mr-1.5 inline-block h-[8px] w-[8px] rounded-[2px]"
                      style={{ background: UNIT_COLORS[myUnits.indexOf(u) % UNIT_COLORS.length] }}
                    />
                    {v} {u}
                  </p>
                ))}
                {opponents.map((o) => (
                  <p key={o} className="font-data mt-0.5 text-[var(--ink-dim)]">
                    {o}: {row[o] ?? 0} supply
                  </p>
                ))}
              </div>
            );
          }}
        />
        {myUnits.map((u, i) => (
          <Area
            isAnimationActive={false}
            key={u}
            type="monotone"
            dataKey={u}
            stackId="me"
            stroke="none"
            fill={UNIT_COLORS[i % UNIT_COLORS.length]}
            fillOpacity={0.55}
          />
        ))}
        {opponents.map((o, i) => (
          <Line
            isAnimationActive={false}
            key={o}
            type="monotone"
            dataKey={o}
            stroke="var(--ink-faint)"
            strokeWidth={1.5}
            strokeDasharray={i === 0 ? "5 4" : "2 3"}
            dot={false}
          />
        ))}
        <Legend
          content={() => (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 px-1 text-[10px] text-[var(--ink-dim)]">
              {myUnits.map((u, i) => (
                <span key={u} className="font-data inline-flex items-center gap-1">
                  <span
                    className="inline-block h-[8px] w-[8px] rounded-[2px]"
                    style={{ background: UNIT_COLORS[i % UNIT_COLORS.length] }}
                  />
                  {u}
                </span>
              ))}
            </div>
          )}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface WorkerMinute {
  minute: number;
  workers: number;
  bases: number;
  saturation: number;
}

export function WorkerChart({
  data,
  expansions,
}: {
  data: WorkerMinute[];
  expansions: { minute: number; item: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <XAxis
          dataKey="minute"
          tickFormatter={(m) => `${m}'`}
          tick={{ fontSize: 10, fontFamily: "var(--font-plex-mono)", fill: "var(--ink-faint)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fontFamily: "var(--font-plex-mono)", fill: "var(--ink-faint)" }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          cursor={{ stroke: "var(--grid-line-strong)" }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="card px-3 py-2 text-[11px]" style={{ background: "var(--hud)" }}>
                <p className="font-data mb-0.5 text-[var(--ink-faint)]">minuto {label}</p>
                <p className="font-data">{payload[0].payload.workers} workers</p>
                <p className="font-data text-[var(--ink-dim)]">
                  {payload[0].payload.bases} base{payload[0].payload.bases !== 1 ? "s" : ""} ·
                  saturación óptima ~{payload[0].payload.saturation}
                </p>
              </div>
            ) : null
          }
        />
        {expansions.map((e, i) => (
          <ReferenceLine
            key={i}
            x={e.minute}
            stroke="var(--minerals)"
            strokeDasharray="3 3"
            label={{
              value: e.item,
              position: "top",
              fontSize: 9,
              fill: "var(--minerals)",
              fontFamily: "var(--font-plex-mono)",
            }}
          />
        ))}
        <Line
            isAnimationActive={false}
          type="stepAfter"
          dataKey="saturation"
          stroke="var(--ink-ghost)"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          dot={false}
        />
        <Line
            isAnimationActive={false}
          type="monotone"
          dataKey="workers"
          stroke="var(--psi)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
