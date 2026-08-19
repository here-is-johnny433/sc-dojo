// Espectro de rendimiento of one game: the five 0–10 variables for every
// player, side by side. Server component — pure markup, no recharts.

import Link from "next/link";
import { RaceTile } from "@/components/RaceTile";
import { RACE_LETTER } from "@/lib/bw";
import { SCORE_KEYS, SCORE_LABELS, SCORE_HINTS, type PlayerScore, type ScoreKey } from "@/lib/scores";

interface PanelPlayer {
  player_id: number;
  name: string;
  race: string | null;
  team: number;
  is_me: boolean;
  is_computer: boolean;
}

function scoreColor(v: number): string {
  if (v >= 7) return "var(--vespene)";
  if (v >= 4) return "var(--energy)";
  return "var(--supply-red)";
}

function ScoreCell({ value, best }: { value: number | null; best: boolean }) {
  if (value == null) {
    return <span className="text-[var(--ink-ghost)]">—</span>;
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-[5px] w-16 overflow-hidden rounded-full bg-[var(--grid-line-soft)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${value * 10}%`, background: scoreColor(value) }}
        />
      </div>
      <span
        className={`font-data w-8 text-right tabular-nums ${best ? "font-semibold" : ""}`}
        style={{ color: best ? "var(--ink)" : "var(--ink-dim)" }}
      >
        {value.toFixed(1)}
      </span>
    </div>
  );
}

export function ScorePanel({
  players,
  scores,
}: {
  players: PanelPlayer[];
  scores: PlayerScore[];
}) {
  const byPlayer = new Map(scores.map((s) => [s.player_id, s]));
  const cols = players.filter((p) => byPlayer.has(p.player_id));
  if (!cols.length) return null;
  const anyWithoutResim = scores.some((s) => !s.with_resim);

  const bestOf = (key: ScoreKey | "overall"): number | null => {
    const vals = cols
      .map((p) => byPlayer.get(p.player_id)?.[key])
      .filter((v): v is number => v != null);
    return vals.length > 1 ? Math.max(...vals) : null;
  };

  return (
    <section className="card p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
          Espectro de rendimiento <span className="normal-case text-[var(--ink-faint)]">(0 = noob · 10 = pro)</span>
        </h3>
        {anyWithoutResim && (
          <p className="text-[11px] text-[var(--ink-faint)]">
            macro y combate se completan al terminar la re-simulación
          </p>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)]">
              <th className="py-2 font-medium">Variable</th>
              {cols.map((p) => (
                <th key={p.player_id} className="pl-4 text-right font-medium">
                  <Link
                    href={`/players/${encodeURIComponent(p.name)}`}
                    className="inline-flex items-center gap-1.5 normal-case tracking-normal hover:underline"
                    style={{ color: p.is_me ? "var(--psi)" : "var(--ink-dim)" }}
                  >
                    <RaceTile letter={RACE_LETTER[p.race ?? ""] ?? "?"} size={14} />
                    <span className="max-w-[120px] truncate text-[12px] font-medium">{p.name}</span>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SCORE_KEYS.map((key) => {
              const best = bestOf(key);
              return (
                <tr key={key} className="border-t border-[var(--grid-line-soft)]">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{SCORE_LABELS[key]}</span>
                    <span className="ml-2 hidden text-[11px] text-[var(--ink-faint)] lg:inline">
                      {SCORE_HINTS[key]}
                    </span>
                  </td>
                  {cols.map((p) => {
                    const v = byPlayer.get(p.player_id)?.[key] ?? null;
                    return (
                      <td key={p.player_id} className="py-2 pl-4">
                        <ScoreCell value={v} best={best != null && v === best} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-t border-[var(--grid-line)]">
              <td className="py-2.5 pr-3 font-semibold">Total</td>
              {cols.map((p) => {
                const v = byPlayer.get(p.player_id)?.overall ?? null;
                const best = bestOf("overall");
                return (
                  <td key={p.player_id} className="py-2.5 pl-4">
                    <ScoreCell value={v} best={best != null && v === best} />
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
