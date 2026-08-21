import Link from "next/link";
import { notFound } from "next/navigation";
import { playerScoreHistory } from "@/lib/queries";
import { RACE_LETTER } from "@/lib/bw";
import { MatchupTiles, RaceTile } from "@/components/RaceTile";
import { ScoreTrend } from "@/components/ScoreTrend";
import {
  summarizeSpectrum,
  toTrendPoints,
  SpectrumTiles,
  FocusBadge,
} from "@/components/SpectrumSummary";
import { SCORE_KEYS, SCORE_LABELS } from "@/lib/scores";

export const dynamic = "force-dynamic";

export default async function PlayerPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const history = await playerScoreHistory(name);
  if (!history.length) notFound();

  const races = [...new Set(history.map((h) => h.race).filter(Boolean))] as string[];
  const decided = history.filter((h) => h.is_winner !== null);
  const wins = decided.filter((h) => h.is_winner).length;

  const { vars, focus } = summarizeSpectrum(history);
  const trend = toTrendPoints(history);

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
          <FocusBadge focus={focus} />
        </div>

        {/* Current level per variable (last 10 games) */}
        <div className="mt-4 border-t border-[var(--grid-line)] pt-4">
          <SpectrumTiles vars={vars} />
        </div>
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
