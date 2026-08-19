import Link from "next/link";
import { knownPlayers } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function PlayersPage() {
  const players = await knownPlayers();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Jugadores</h1>
        <p className="text-[12px] text-[var(--ink-faint)]">
          {players.length} vistos en tus replays · cada perfil muestra su espectro de rendimiento en el tiempo
        </p>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[480px] text-[13px]">
          <thead>
            <tr className="border-b border-[var(--grid-line)] text-left text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)]">
              <th className="py-2.5 pl-5 font-medium">Jugador</th>
              <th className="font-medium">Partidas</th>
              <th className="pr-5 text-right font-medium">Última partida</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr
                key={p.name}
                className="border-b border-[var(--grid-line-soft)] transition-colors last:border-0 hover:bg-[var(--hud)]"
              >
                <td className="py-2.5 pl-5">
                  <Link
                    href={`/players/${encodeURIComponent(p.name)}`}
                    className="font-medium hover:underline"
                    style={p.is_me ? { color: "var(--psi)" } : undefined}
                  >
                    {p.name}
                    {p.is_me && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--ink-faint)]">
                        yo
                      </span>
                    )}
                  </Link>
                </td>
                <td className="font-data text-[12px] tabular-nums text-[var(--ink-dim)]">{p.games}</td>
                <td className="font-data pr-5 text-right text-[12px] text-[var(--ink-faint)]">
                  {p.last_played
                    ? new Date(p.last_played).toLocaleDateString("es", {
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
