import Link from "next/link";

// Signature element: recent games as minimap-style square dots.
export function FormStrip({
  games,
  size = 10,
}: {
  games: { id: string; i_won: boolean | null; map_name: string | null }[];
  size?: number;
}) {
  return (
    <span className="inline-flex items-center gap-[3px]">
      {games.map((g) => (
        <Link
          key={g.id}
          href={`/games/${g.id}`}
          title={`${g.map_name ?? "?"} — ${g.i_won === null ? "sin resultado" : g.i_won ? "victoria" : "derrota"}`}
          className="transition-transform hover:scale-125"
          style={{
            width: size,
            height: size,
            borderRadius: 2,
            background:
              g.i_won === null
                ? "var(--ink-ghost)"
                : g.i_won
                  ? "var(--vespene)"
                  : "var(--supply-red)",
          }}
        />
      ))}
    </span>
  );
}
