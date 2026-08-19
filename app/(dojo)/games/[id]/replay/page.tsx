import Link from "next/link";
import { notFound } from "next/navigation";
import { gameDetail } from "@/lib/queries";
import { resimStatus } from "@/lib/viewer-data";
import { fmtTime } from "@/lib/bw";
import { MatchupTiles } from "@/components/RaceTile";
import { ReplayPlayer } from "@/components/ReplayPlayer";

export const dynamic = "force-dynamic";

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{16}$/.test(id)) notFound();
  const detail = await gameDetail(id);
  if (!detail) notFound();
  const { game } = detail;
  const resim = await resimStatus(id);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <Link
            href={`/games/${game.id}`}
            className="font-data text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)] hover:text-[var(--psi)]"
          >
            ← volver a la partida
          </Link>
          <h1 className="mt-0.5 truncate text-lg font-semibold tracking-tight">
            {game.map_name}
          </h1>
        </div>
        <span className="font-data text-[11px] text-[var(--ink-faint)]">
          {fmtTime(game.duration_seconds ?? 0)} · {game.game_type} ·{" "}
          {resim === "done"
            ? "re-simulado con OpenBW"
            : "derivado de los comandos"}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <MatchupTiles matchup={game.my_matchup ?? game.matchup} size={18} />
          {game.i_won != null && (
            <span
              className="font-data border px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={
                game.i_won
                  ? {
                      color: "var(--vespene)",
                      background: "var(--vespene-dim)",
                      borderColor: "rgba(88,194,110,0.35)",
                    }
                  : {
                      color: "var(--supply-red)",
                      background: "var(--supply-red-dim)",
                      borderColor: "rgba(224,83,79,0.35)",
                    }
              }
            >
              {game.i_won ? "Victoria" : "Derrota"}
            </span>
          )}
        </div>
      </div>

      <ReplayPlayer gameId={game.id} resimStatus={resim} />
    </div>
  );
}
