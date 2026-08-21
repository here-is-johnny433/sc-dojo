// Resumen del espectro de rendimiento a partir de un historial de scores:
// nivel actual por variable (promedio de las últimas 10 partidas), delta vs
// las 10 anteriores y la variable más débil ("oportunidad"). Compartido por el
// dashboard (centro de aprendizaje) y los perfiles de jugador.

import { SCORE_KEYS, SCORE_LABELS, type ScoreKey } from "@/lib/scores";
import type { ScoreHistoryRow } from "@/lib/queries";
import type { TrendPoint } from "@/components/ScoreTrend";

export interface SpectrumVar {
  key: ScoreKey;
  label: string;
  now: number | null;
  delta: number | null;
}

const avg = (vals: (number | null)[]): number | null => {
  const xs = vals.filter((v): v is number => v != null);
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
};

export function summarizeSpectrum(history: ScoreHistoryRow[]): {
  vars: SpectrumVar[];
  focus: SpectrumVar | null;
} {
  const recent = history.slice(-10);
  const previous = history.slice(-20, -10);
  const vars = SCORE_KEYS.map((key: ScoreKey) => {
    const now = avg(recent.map((h) => h[key]));
    const before = previous.length >= 3 ? avg(previous.map((h) => h[key])) : null;
    const delta = now != null && before != null ? Math.round((now - before) * 10) / 10 : null;
    return { key, label: SCORE_LABELS[key], now, delta };
  });
  const focus =
    vars.filter((s) => s.now != null).sort((a, b) => (a.now ?? 99) - (b.now ?? 99))[0] ?? null;
  return { vars, focus };
}

export function toTrendPoints(history: ScoreHistoryRow[]): TrendPoint[] {
  return history.map((h) => ({
    game_id: h.game_id,
    label: h.played_at
      ? new Date(h.played_at).toLocaleDateString("es", { day: "2-digit", month: "short" })
      : "?",
    mechanics: h.mechanics,
    economy: h.economy,
    macro: h.macro,
    combat: h.combat,
    build: h.build,
    overall: h.overall,
  }));
}

export function SpectrumTiles({ vars }: { vars: SpectrumVar[] }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {vars.map((s) => (
          <div key={s.key}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)]">
              {s.label}
            </p>
            <p className="font-data mt-0.5 text-lg tabular-nums">
              {s.now != null ? s.now.toFixed(1) : "—"}
              {s.delta != null && s.delta !== 0 && (
                <span
                  className="ml-1.5 text-[11px]"
                  style={{ color: s.delta > 0 ? "var(--vespene)" : "var(--supply-red)" }}
                >
                  {s.delta > 0 ? "▲" : "▼"} {Math.abs(s.delta).toFixed(1)}
                </span>
              )}
            </p>
            <div className="mt-1 h-[4px] w-full overflow-hidden rounded-full bg-[var(--grid-line-soft)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(s.now ?? 0) * 10}%`,
                  background:
                    (s.now ?? 0) >= 7
                      ? "var(--vespene)"
                      : (s.now ?? 0) >= 4
                        ? "var(--energy)"
                        : "var(--supply-red)",
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[var(--ink-faint)]">
        nivel actual = promedio de las últimas 10 partidas · ▲▼ vs las 10 anteriores
      </p>
    </>
  );
}

export function FocusBadge({ focus }: { focus: SpectrumVar | null }) {
  if (!focus || focus.now == null) return null;
  return (
    <div
      className="rounded-md px-3 py-2 text-[12px]"
      style={{ background: "var(--psi-dim)", color: "var(--psi)" }}
    >
      Oportunidad: <span className="font-semibold">{focus.label}</span> ({focus.now.toFixed(1)}/10)
    </div>
  );
}
