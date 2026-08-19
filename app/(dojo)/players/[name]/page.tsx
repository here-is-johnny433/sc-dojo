import Link from "next/link";
import { notFound } from "next/navigation";
import { playerScoreHistory } from "@/lib/queries";
import { fmtTime, RACE_LETTER } from "@/lib/bw";
import { MatchupTiles, RaceTile } from "@/components/RaceTile";
import { ScoreTrend, TrendPoint } from "@/components/ScoreTrend";
import { SCORE_KEYS, SCORE_LABELS, type ScoreKey } from "@/lib/scores";

export const dynamic = "force-dynamic";

const avg = (vals: (number | null)[]): number | null => {
  const xs = vals.filter((v): v is number => v != null);
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
};

export default async function PlayerPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const history = await playerScoreHistory(name);
  if (!history.length) notFound();

  const races = [...new Set(history.map((h) => h.race).filter(Boolean))] as string[];
  const decided = history.filter((h) => h.is_winner !== null);
  const wins = decided.filter((h) => h.is_winner).length;

  // Current level = average of the last 10 games; delta vs the 10 before.
  const recent = history.slice(-10);
  const previous = history.slice(-20, -10);
  const summary = SCORE_KEYS.map((key: ScoreKey) => {
    const now = avg(recent.map((h) => h[key]));
    const before = previous.length >= 3 ? avg(previous.map((h) => h[key])) : null;
    const delta = now != null && before != null ? Math.round((now - before) * 10) / 10 : null;
    return { key, label: SCORE_LABELS[key], now, delta };
  });
  // Where to focus: the weakest variable of the recent window.
  const focus = summary
    .filter((s) => s.now != null)
    .sort((a, b) => (a.now ?? 99) - (b.now ?? 99))[0];

  const trend: TrendPoint[] = history.map((h) => ({
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

  return (
    <div className="space-y-5">
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              {races.map((r) => (
                <RaceTile key={r} letter={RACE_LETTER[r] ?? "?"} size={20} />
              ))}
              <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
            </div>
            <p className="font-data mt-1 text-[12px] text-[var(--ink-faint)]">
              {history.length} partidas con score
              {decided.length > 0 &&
                ` · ${wins}W ${decided.length - wins}L (${Math.round((100 * wins) / decided.length)}%)`}
            </p>
          </div>
          {focus?.now != null && (
            <div
              className="rounded-md px-3 py-2 text-[12px]"
              style={{ background: "var(--psi-dim)", color: "var(--psi)" }}
            >
              Oportunidad: <span className="font-semibold">{focus.label}</span>{" "}
              ({focus.now.toFixed(1)}/10)
            </div>
          )}
        </div>

        {/* Current level per variable (last 10 games) */}
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--grid-line)] pt-4 sm:grid-cols-5">
          {summary.map((s) => (
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
      </section>

      <section className="card p-5">
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
          Evolución <span className="normal-case text-[var(--ink-faint)]">(0 = noob · 10 = pro)</span>
        </h3>
        <ScoreTrend data={trend} />
      </section>

      <section className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-[var(--grid-line)] text-left text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)]">
              <th className="py-2.5 pl-5 font-medium">Fecha</th>
              <th className="font-medium">Mapa</th>
              <th className="font-medium">Matchup</th>
              <th className="font-medium">Resultado</th>
              {SCORE_KEYS.map((k) => (
                <th key={k} className="text-right font-medium">
                  {SCORE_LABELS[k].split(" ")[0]}
                </th>
              ))}
              <th className="pr-5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {[...history].reverse().map((h) => (
              <tr
                key={h.game_id}
                className="border-b border-[var(--grid-line-soft)] transition-colors last:border-0 hover:bg-[var(--hud)]"
              >
                <td className="font-data py-2.5 pl-5 text-[12px] text-[var(--ink-faint)]">
                  <Link href={`/games/${h.game_id}`}>
                    {h.played_at
                      ? new Date(h.played_at).toLocaleDateString("es", {
                          day: "2-digit",
                          month: "short",
                          year: "2-digit",
                        })
                      : "—"}
                  </Link>
                </td>
                <td className="font-medium">
                  <Link href={`/games/${h.game_id}`}>{h.map_name ?? "?"}</Link>
                </td>
                <td>
                  <MatchupTiles matchup={h.my_matchup ?? h.matchup} size={14} />
                </td>
                <td className="font-data text-[11px] uppercase">
                  <span
                    style={{
                      color:
                        h.is_winner === null
                          ? "var(--ink-ghost)"
                          : h.is_winner
                            ? "var(--vespene)"
                            : "var(--supply-red)",
                    }}
                  >
                    {h.is_winner === null ? "—" : h.is_winner ? "win" : "loss"}
                  </span>
                </td>
                {SCORE_KEYS.map((k) => (
                  <td key={k} className="font-data text-right text-[12px] tabular-nums text-[var(--ink-dim)]">
                    {h[k] != null ? h[k]!.toFixed(1) : "—"}
                  </td>
                ))}
                <td className="font-data pr-5 text-right font-semibold tabular-nums">
                  {h.overall != null ? h.overall.toFixed(1) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
