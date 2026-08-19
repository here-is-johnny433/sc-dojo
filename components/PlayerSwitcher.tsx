"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

interface Player {
  id: number;
  name: string;
}

/** Las estadísticas son públicas entre jugadores: este selector cambia la
 *  perspectiva de la página con ?player=<id>. */
export function PlayerSwitcher({
  players,
  value,
  sessionId,
}: {
  players: Player[];
  value: number;
  sessionId: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (players.length < 2) return null;

  function pick(id: number) {
    const p = new URLSearchParams(params.toString());
    if (id === sessionId) p.delete("player");
    else p.set("player", String(id));
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <label className="flex items-center gap-2 text-[12px] text-[var(--ink-faint)]">
      Viendo
      <select
        value={value}
        onChange={(e) => pick(Number(e.target.value))}
        className="text-[12px]"
      >
        {players.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.id === sessionId ? " (tú)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
