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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href={`/games/${game.id}`}
            className="font-data text-[11px] uppercase tracking-[0.15em] text-[var(--ink-faint)] hover:text-[var(--psi)]"
          >
            ← volver a la partida
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{game.map_name}</h1>
          <p className="font-data text-[12px] text-[var(--ink-faint)]">
            {fmtTime(game.duration_seconds ?? 0)} · {game.game_type} ·{" "}
            {resim === "done"
              ? "unidades, economía y bajas re-simuladas con OpenBW"
              : "edificios y órdenes desde los comandos del replay"}
          </p>
        </div>
        <MatchupTiles matchup={game.my_matchup ?? game.matchup} size={20} />
      </div>

      <ReplayPlayer gameId={game.id} resimStatus={resim} />
    </div>
  );
}
