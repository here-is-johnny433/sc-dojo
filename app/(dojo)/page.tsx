import Link from "next/link";
import {
  overviewStats,
  matchupStats,
  mapStats,
  monthlyTrend,
  recentGames,
  activeGoal,
  goalStreak,
  listPlayers,
  userScoreHistory,
} from "@/lib/queries";
import { requireUser } from "@/lib/session";
import { fmtTime } from "@/lib/bw";
import { MatchupTiles } from "@/components/RaceTile";
import { FormStrip } from "@/components/FormStrip";
import { PlayerSwitcher } from "@/components/PlayerSwitcher";
import { ApmTrend, WinrateTrend } from "@/components/TrendCharts";
import { ScoreTrend } from "@/components/ScoreTrend";
import {
  summarizeSpectrum,
  toTrendPoints,
  SpectrumTiles,
  FocusBadge,
} from "@/components/SpectrumSummary";

export const dynamic = "force-dynamic";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ player?: string }>;
}) {
  const user = await requireUser();
  const players = await listPlayers();
  const requested = Number((await searchParams).player);
  const viewed = players.find((p) => p.id === requested) ?? { id: user.id, name: user.name };
  // Las metas son privadas: solo se muestran al dueño (el admin ve todas).
  const showGoal = viewed.id === user.id || user.role === "admin";

  const [stats, matchups, maps, trend, games, goal, scoreHistory] = await Promise.all([
    overviewStats(viewed.id),
    matchupStats(viewed.id),
    mapStats(viewed.id),
    monthlyTrend(viewed.id),
    recentGames(viewed.id, 20),
    showGoal ? activeGoal(viewed.id) : null,
    userScoreHistory(viewed.id),
  ]);
  const spectrum = summarizeSpectrum(scoreHistory);

  const winrate =
    stats.decided > 0 ? Math.round((100 * stats.wins) / stats.decided) : null;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight">
        {viewed.id === user.id ? "Tu dojo" : `Dojo de ${viewed.name}`}
      </h1>
      <PlayerSwitcher players={players} value={viewed.id} sessionId={user.id} />
    </div>
  );

  if (!stats.games) {
    return (
      <div className="space-y-4">
        {header}
        <div className="card mx-auto mt-10 max-w-lg p-10 text-center">
          <p className="font-data text-[11px] uppercase tracking-[0.25em] text-[var(--psi)]">
            Dojo vacío
          </p>
          <h2 className="mb-2 mt-1 text-xl font-semibold">Aún no hay partidas</h2>
          {viewed.id === user.id ? (
            <>
              <p className="mb-6 text-[13px] text-[var(--ink-dim)]">
                Sube tus replays o corre <code className="font-data">pnpm ingest</code> para
                importar tu carpeta de AutoSave.
              </p>
              <Link href="/games" className="btn btn-psi">
                Subir replays
              </Link>
            </>
          ) : (
            <p className="text-[13px] text-[var(--ink-dim)]">
              {viewed.name} todavía no tiene partidas vinculadas a sus cuentas.
            </p>
          )}
        </div>
      </div>
    );
  }

  const streak = goal ? goalStreak(goal.recent_checks) : 0;

  return (
    <div className="space-y-5">
      {header}

      {/* Active goal — the point of the dojo */}
      {!showGoal ? null : goal ? (
        <section
          className="relative overflow-hidden border p-5"
          style={{
            borderColor: "rgba(255,207,63,0.42)",
            background: "linear-gradient(90deg, rgba(36,29,8,0.75), rgba(8,18,14,0.6))",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <span
                className="font-data flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border-2 text-[14px] font-semibold"
                style={{ borderColor: "var(--gold)", color: "var(--gold)" }}
              >
                ◎
              </span>
              <div>
              <p className="font-data text-[10px] uppercase tracking-[0.2em] text-[var(--gold)]">
                Objetivo activo · {goal.area}
              </p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight" style={{ color: "#f7ecd0" }}>{goal.title}</h2>
              <p className="mt-0.5 text-[12px] text-[var(--ink-dim)]">
                Meta: {goal.metric_key} {goal.comparator} {goal.target_value} · necesitas{" "}
                {goal.streak_required} partidas seguidas
              </p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-data text-4xl font-semibold tabular-nums">
                {streak}
                <span className="text-lg text-[var(--ink-faint)]">/{goal.streak_required}</span>
              </p>
              <p className="text-[11px] text-[var(--ink-faint)]">racha actual</p>
            </div>
          </div>
          {goal.recent_checks.length > 0 && (
            <div className="mt-3 flex items-center gap-[3px]">
              {[...goal.recent_checks].reverse().map(
                (c: { game_id: string; passed: boolean; measured: number }, i: number) => (
                  <span
                    key={i}
                    title={`${c.measured}`}
                    className="h-[10px] w-[10px] rounded-[2px]"
                    style={{
                      background: c.passed ? "var(--vespene)" : "var(--supply-red)",
                    }}
                  />
                )
              )}
              <span className="ml-2 text-[11px] text-[var(--ink-faint)]">
                últimas {goal.recent_checks.length} evaluaciones
              </span>
            </div>
          )}
        </section>
      ) : (
        <section className="card flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <p className="font-data text-[10px] uppercase tracking-[0.25em] text-[var(--ink-faint)]">
              Ciclo dojo
            </p>
            <p className="mt-1 text-[13px] text-[var(--ink-dim)]">
              Sin objetivo activo. Pídele al coach un diagnóstico para definir tu próximo foco.
            </p>
          </div>
          <Link href="/chat" className="btn btn-psi">
            Pedir diagnóstico
          </Link>
        </section>
      )}

      {/* Espectro de rendimiento — el centro de aprendizaje */}
      {scoreHistory.length > 0 && (
        <section className="card p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
              Espectro de rendimiento{" "}
              <span className="normal-case text-[var(--ink-faint)]">(0 = noob · 10 = pro)</span>
            </h3>
            <FocusBadge focus={spectrum.focus} />
          </div>
          <SpectrumTiles vars={spectrum.vars} />
          <div className="mt-5 border-t border-[var(--grid-line)] pt-4">
            <ScoreTrend data={toTrendPoints(scoreHistory)} />
          </div>
        </section>
      )}

      {/* Hero stats */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wider text-[var(--ink-faint)]">Winrate</p>
          <p className="font-data mt-1 text-3xl font-semibold tabular-nums">
            {winrate === null ? "—" : `${winrate}%`}
          </p>
          <div className="mt-2">
            <FormStrip games={[...games].reverse()} />
          </div>
        </div>
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wider text-[var(--ink-faint)]">APM promedio</p>
          <p className="font-data mt-1 text-3xl font-semibold tabular-nums">{stats.avg_apm ?? "—"}</p>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">EAPM {stats.avg_eapm ?? "—"}</p>
        </div>
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wider text-[var(--ink-faint)]">Hotkeys</p>
          <p className="font-data mt-1 text-3xl font-semibold tabular-nums">
            {stats.avg_hotkey_pct != null ? `${stats.avg_hotkey_pct}%` : "—"}
          </p>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">de tus acciones</p>
        </div>
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wider text-[var(--ink-faint)]">Partidas</p>
          <p className="font-data mt-1 text-3xl font-semibold tabular-nums">{stats.games}</p>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">competitivas</p>
        </div>
      </section>

      {/* Matchups + maps */}
      <section className="grid gap-3 lg:grid-cols-2">
        <div className="card p-5">
          <h3 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
            Winrate por matchup
          </h3>
          <div className="space-y-3">
            {matchups.map((m) => (
              <div key={m.my_matchup} className="flex items-center gap-3">
                <div className="w-28 shrink-0">
                  <MatchupTiles matchup={m.my_matchup} size={16} />
                </div>
                <div className="h-[8px] flex-1 overflow-hidden rounded-full bg-[var(--hud)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${m.winrate_pct ?? 0}%`,
                      background:
                        (m.winrate_pct ?? 0) >= 50 ? "var(--vespene)" : "var(--supply-red)",
                      opacity: 0.85,
                    }}
                  />
                </div>
                <p className="font-data w-20 shrink-0 text-right text-[12px] tabular-nums text-[var(--ink-dim)]">
                  {m.winrate_pct ?? "—"}% · {m.games}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div className="card p-5">
          <h3 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
            Winrate por mapa
          </h3>
          <div className="space-y-3">
            {maps.map((m) => (
              <div key={m.map_name} className="flex items-center gap-3">
                <p className="w-28 shrink-0 truncate text-[12px] text-[var(--ink-dim)]">
                  {m.map_name}
                </p>
                <div className="h-[8px] flex-1 overflow-hidden rounded-full bg-[var(--hud)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${m.winrate_pct ?? 0}%`,
                      background:
                        (m.winrate_pct ?? 0) >= 50 ? "var(--vespene)" : "var(--supply-red)",
                      opacity: 0.85,
                    }}
                  />
                </div>
                <p className="font-data w-20 shrink-0 text-right text-[12px] tabular-nums text-[var(--ink-dim)]">
                  {m.winrate_pct ?? "—"}% · {m.games}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trends */}
      <section className="grid gap-3 lg:grid-cols-2">
        <div className="card p-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
              APM mensual
            </h3>
            <p className="font-data text-[10px] text-[var(--ink-faint)]">
              — APM &nbsp;· · EAPM
            </p>
          </div>
          <ApmTrend data={trend} />
        </div>
        <div className="card p-5">
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
            Winrate mensual
          </h3>
          <WinrateTrend data={trend} />
        </div>
      </section>

      {/* Recent games */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--grid-line)] px-5 py-3.5">
          <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
            Últimas partidas
          </h3>
          <Link
            href={viewed.id === user.id ? "/games" : `/games?player=${viewed.id}`}
            className="text-[12px] text-[var(--minerals)] hover:underline"
          >
            Ver todas →
          </Link>
        </div>
        <table className="w-full text-[13px]">
          <tbody>
            {games.slice(0, 8).map((g) => (
              <tr
                key={g.id}
                className="border-b border-[var(--grid-line-soft)] transition-colors last:border-0 hover:bg-[var(--hud)]"
              >
                <td className="py-2.5 pl-5">
                  <Link href={`/games/${g.id}`} className="flex items-center gap-2.5">
                    <span
                      className="h-[9px] w-[9px] shrink-0 rounded-[2px]"
                      style={{
                        background:
                          g.i_won === null
                            ? "var(--ink-ghost)"
                            : g.i_won
                              ? "var(--vespene)"
                              : "var(--supply-red)",
                      }}
                    />
                    <span className="font-medium">{g.map_name ?? "?"}</span>
                  </Link>
                </td>
                <td className="hidden py-2.5 sm:table-cell">
                  <MatchupTiles matchup={g.my_matchup} size={15} />
                </td>
                <td className="font-data py-2.5 text-[12px] tabular-nums text-[var(--ink-dim)]">
                  {g.duration_seconds != null ? fmtTime(g.duration_seconds) : "—"}
                </td>
                <td className="font-data hidden py-2.5 text-[12px] tabular-nums text-[var(--ink-dim)] md:table-cell">
                  {g.apm ?? "—"} APM
                </td>
                <td className="font-data py-2.5 pr-5 text-right text-[12px] text-[var(--ink-faint)]">
                  {g.played_at
                    ? new Date(g.played_at).toLocaleDateString("es", {
                        day: "numeric",
                        month: "short",
                      })
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
