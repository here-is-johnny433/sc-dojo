import Link from "next/link";
import { db } from "@/lib/db";
import { fmtTime } from "@/lib/bw";
import { GameRow, listPlayers } from "@/lib/queries";
import { requireUser } from "@/lib/session";
import { MatchupTiles } from "@/components/RaceTile";
import { PlayerSwitcher } from "@/components/PlayerSwitcher";
import { UploadDrop } from "@/components/UploadDrop";

export const dynamic = "force-dynamic";

interface Filters {
  map?: string;
  matchup?: string;
  result?: string;
  player?: string;
}

async function filteredGames(
  userId: number,
  f: Filters
): Promise<(GameRow & { overall: number | null })[]> {
  const where: string[] = ["v.user_id = $1"];
  const params: unknown[] = [userId];
  if (f.map) {
    params.push(f.map);
    where.push(`v.map_name = $${params.length}`);
  }
  if (f.matchup) {
    params.push(f.matchup);
    where.push(`v.my_matchup = $${params.length}`);
  }
  if (f.result === "win") where.push(`v.i_won = true`);
  if (f.result === "loss") where.push(`v.i_won = false`);
  if (f.result === "practice") where.push(`v.is_practice`);
  const sql = `SELECT v.*, s.overall
               FROM v_player_games v
               JOIN game_players gp ON gp.game_id = v.id AND gp.user_id = v.user_id
               LEFT JOIN player_scores s ON s.game_id = v.id AND s.player_id = gp.player_id
               WHERE ${where.join(" AND ")}
               ORDER BY v.played_at DESC NULLS LAST LIMIT 200`;
  return (await db().query(sql, params)).rows;
}

export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<Filters>;
}) {
  const filters = await searchParams;
  const user = await requireUser();
  const players = await listPlayers();
  const requested = Number(filters.player);
  const viewed = players.find((p) => p.id === requested) ?? { id: user.id, name: user.name };

  const [games, mapsR] = await Promise.all([
    filteredGames(viewed.id, filters),
    db().query(
      `SELECT DISTINCT map_name FROM v_player_games WHERE user_id = $1 AND map_name IS NOT NULL ORDER BY 1`,
      [viewed.id]
    ),
  ]);

  const qs = (patch: Partial<Filters>) => {
    const merged = { ...filters, ...patch };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/games?${s}` : "/games";
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Partidas{viewed.id === user.id ? "" : ` de ${viewed.name}`}
          </h1>
          <p className="text-[12px] text-[var(--ink-faint)]">{games.length} en vista</p>
        </div>
        <PlayerSwitcher players={players} value={viewed.id} sessionId={user.id} />
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {/* filters as links keep the page a pure server component */}
          <div className="flex overflow-hidden rounded-md border border-[var(--grid-line)]">
            {[
              ["", "Todas"],
              ["win", "Victorias"],
              ["loss", "Derrotas"],
              ["practice", "Práctica"],
            ].map(([val, label]) => (
              <Link
                key={val}
                href={qs({ result: val || undefined })}
                className="px-3 py-1.5 transition-colors"
                style={
                  (filters.result ?? "") === val
                    ? { background: "var(--psi-dim)", color: "var(--psi)" }
                    : { color: "var(--ink-dim)" }
                }
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <UploadDrop />

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <Link
          href={qs({ map: undefined, matchup: undefined })}
          className="rounded-full border border-[var(--grid-line)] px-2.5 py-1 text-[var(--ink-dim)] hover:border-[var(--grid-line-strong)]"
        >
          limpiar filtros
        </Link>
        {mapsR.rows.map((m) => (
          <Link
            key={m.map_name}
            href={qs({ map: filters.map === m.map_name ? undefined : m.map_name })}
            className="rounded-full border px-2.5 py-1 transition-colors"
            style={
              filters.map === m.map_name
                ? { borderColor: "var(--psi)", color: "var(--psi)", background: "var(--psi-dim)" }
                : { borderColor: "var(--grid-line)", color: "var(--ink-dim)" }
            }
          >
            {m.map_name}
          </Link>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-[var(--grid-line)] text-left text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)]">
              <th className="py-2.5 pl-5 font-medium">Resultado</th>
              <th className="font-medium">Mapa</th>
              <th className="font-medium">Matchup</th>
              <th className="font-medium">Duración</th>
              <th className="font-medium">APM</th>
              <th className="font-medium">Hotkeys</th>
              <th className="font-medium">Score</th>
              <th className="pr-5 text-right font-medium">Fecha</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr
                key={g.id}
                className="border-b border-[var(--grid-line-soft)] transition-colors last:border-0 hover:bg-[var(--hud)]"
              >
                <td className="py-2.5 pl-5">
                  <Link href={`/games/${g.id}`} className="flex items-center gap-2">
                    <span
                      className="h-[9px] w-[9px] rounded-[2px]"
                      style={{
                        background:
                          g.i_won === null
                            ? "var(--ink-ghost)"
                            : g.i_won
                              ? "var(--vespene)"
                              : "var(--supply-red)",
                      }}
                    />
                    <span className="font-data text-[11px] uppercase text-[var(--ink-dim)]">
                      {g.is_practice ? "práctica" : g.i_won === null ? "—" : g.i_won ? "win" : "loss"}
                    </span>
                  </Link>
                </td>
                <td className="font-medium">
                  <Link href={`/games/${g.id}`}>{g.map_name ?? "?"}</Link>
                </td>
                <td><MatchupTiles matchup={g.my_matchup} size={15} /></td>
                <td className="font-data text-[12px] tabular-nums text-[var(--ink-dim)]">
                  {g.duration_seconds != null ? fmtTime(g.duration_seconds) : "—"}
                </td>
                <td className="font-data text-[12px] tabular-nums text-[var(--ink-dim)]">
                  {g.apm ?? "—"}
                </td>
                <td className="font-data text-[12px] tabular-nums text-[var(--ink-dim)]">
                  {g.hotkey_pct != null ? `${g.hotkey_pct}%` : "—"}
                </td>
                <td className="font-data text-[12px] font-semibold tabular-nums">
                  {g.overall != null ? (
                    <span
                      style={{
                        color:
                          g.overall >= 7
                            ? "var(--vespene)"
                            : g.overall >= 4
                              ? "var(--energy)"
                              : "var(--supply-red)",
                      }}
                    >
                      {g.overall.toFixed(1)}
                    </span>
                  ) : (
                    <span className="text-[var(--ink-ghost)]">—</span>
                  )}
                </td>
                <td className="font-data pr-5 text-right text-[12px] text-[var(--ink-faint)]">
                  {g.played_at
                    ? new Date(g.played_at).toLocaleDateString("es", {
                        day: "2-digit",
                        month: "short",
                        year: "2-digit",
                      })
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
