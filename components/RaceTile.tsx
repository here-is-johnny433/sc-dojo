// Signature element: race letters as colored tiles, used for matchups and players.
const RACE_COLORS: Record<string, string> = {
  P: "var(--protoss)",
  T: "var(--terran)",
  Z: "var(--zerg)",
};

export function RaceTile({ letter, size = 20 }: { letter: string; size?: number }) {
  const color = RACE_COLORS[letter] ?? "var(--ink-faint)";
  return (
    <span
      className="font-data inline-flex items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.58,
        color,
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        borderRadius: 4,
      }}
    >
      {letter}
    </span>
  );
}

// Renders "PZ vs TT" as tile groups.
export function MatchupTiles({ matchup, size = 18 }: { matchup: string | null; size?: number }) {
  if (!matchup) return <span className="text-[var(--ink-faint)]">—</span>;
  const parts = matchup.split(" vs ");
  return (
    <span className="inline-flex items-center gap-1.5">
      {parts.map((side, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && (
            <span className="text-[10px] uppercase tracking-wider text-[var(--ink-faint)]">vs</span>
          )}
          <span className="inline-flex gap-0.5">
            {side.replace("+", "").split("").map((l, j) => (
              <RaceTile key={j} letter={l} size={size} />
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}
