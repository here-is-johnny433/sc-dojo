import Link from "next/link";
import { notFound } from "next/navigation";
import { gameDetail } from "@/lib/queries";
import { fmtTime, WORKERS, RESOURCE_DEPOTS, RACE_LETTER } from "@/lib/bw";
import { MatchupTiles, RaceTile } from "@/components/RaceTile";
import { ArmyChart, WorkerChart, ArmyMinute, WorkerMinute } from "@/components/GameCharts";

export const dynamic = "force-dynamic";

interface Ev {
  player_id: number;
  player_name: string;
  frame: number;
  seconds: number;
  kind: string;
  item: string;
  supply_cost: number | null;
}

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{16}$/.test(id)) notFound();
  const detail = await gameDetail(id);
  if (!detail) notFound();
  const { game, players, events, observations } = detail;

  const me = players.find((p) => p.is_me);
  const minutes = Math.max(1, Math.ceil((game.duration_seconds ?? 0) / 60));
  const evs = events as Ev[];

  // --- Army chart data: my stacked unit mix + opponents' total supply lines ---
  const myArmyEvents = me
    ? evs.filter(
        (e) =>
          e.player_id === me.player_id &&
          (e.kind === "Train" || e.kind === "Unit Morph") &&
          !WORKERS.has(e.item)
      )
    : [];
  const myUnitTypes = [...new Set(myArmyEvents.map((e) => e.item))];
  const opponents = me ? players.filter((p) => p.team !== me.team) : [];
  const oppNames = opponents.map((p) => p.name);

  const armyData: ArmyMinute[] = [];
  for (let m = 0; m <= minutes; m++) {
    const row: ArmyMinute = { minute: m };
    for (const u of myUnitTypes) {
      row[u] = myArmyEvents.filter((e) => e.item === u && e.seconds <= m * 60).length;
    }
    for (const p of opponents) {
      row[p.name] = evs
        .filter(
          (e) =>
            e.player_id === p.player_id &&
            (e.kind === "Train" || e.kind === "Unit Morph") &&
            !WORKERS.has(e.item) &&
            e.seconds <= m * 60
        )
        .reduce((s, e) => s + (e.supply_cost ?? 0), 0);
    }
    armyData.push(row);
  }

  // --- Worker chart: cumulative workers, bases, estimated saturation (~21/base) ---
  const myWorkerSecs = me
    ? evs
        .filter(
          (e) =>
            e.player_id === me.player_id &&
            WORKERS.has(e.item) &&
            (e.kind === "Train" || e.kind === "Unit Morph")
        )
        .map((e) => e.seconds)
    : [];
  const myExpansions = me
    ? evs.filter(
        (e) => e.player_id === me.player_id && e.kind === "Build" && RESOURCE_DEPOTS.has(e.item)
      )
    : [];
  const workerData: WorkerMinute[] = [];
  for (let m = 0; m <= minutes; m++) {
    const bases = 1 + myExpansions.filter((e) => e.seconds <= m * 60).length;
    workerData.push({
      minute: m,
      workers: 4 + myWorkerSecs.filter((s) => s <= m * 60).length,
      bases,
      saturation: bases * 21,
    });
  }

  // --- Build order columns (mine first, then allies, then opponents) ---
  const ordered = [...players].sort((a, b) => {
    const rank = (p: typeof a) => (p.is_me ? 0 : p.team === me?.team ? 1 : 2);
    return rank(a) - rank(b) || a.player_id - b.player_id;
  });
  const structural = (e: Ev) =>
    e.kind !== "Train" || !WORKERS.has(e.item); // hide worker spam in the timeline

  return (
    <div className="space-y-5">
      {/* Header */}
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight">{game.map_name}</h1>
              <span
                className="rounded-md px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
                style={
                  game.i_won === null
                    ? { background: "var(--hud)", color: "var(--ink-dim)" }
                    : game.i_won
                      ? { background: "var(--vespene-dim)", color: "var(--vespene)" }
                      : { background: "var(--supply-red-dim)", color: "var(--supply-red)" }
                }
              >
                {game.is_practice
                  ? "práctica"
                  : game.i_won === null
                    ? "sin resultado"
                    : game.i_won
                      ? "victoria"
                      : "derrota"}
              </span>
            </div>
            <p className="font-data mt-1 text-[12px] text-[var(--ink-faint)]">
              {game.played_at &&
                new Date(game.played_at).toLocaleString("es", {
                  dateStyle: "long",
                  timeStyle: "short",
                })}{" "}
              · {fmtTime(game.duration_seconds ?? 0)} · {game.game_type}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <MatchupTiles matchup={game.my_matchup ?? game.matchup} size={20} />
            <Link href={`/games/${game.id}/replay`} className="btn">
              Ver replay
            </Link>
            <Link href={`/chat?game=${game.id}`} className="btn btn-psi">
              Analizar con el coach
            </Link>
          </div>
        </div>

        <table className="mt-4 w-full border-t border-[var(--grid-line)] pt-3 text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)]">
              <th className="py-2 font-medium">Jugador</th>
              <th className="font-medium">Equipo</th>
              <th className="text-right font-medium">APM</th>
              <th className="text-right font-medium">EAPM</th>
              <th className="pr-1 text-right font-medium">Hotkeys</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((p) => (
              <tr
                key={p.player_id}
                className="border-t border-[var(--grid-line-soft)]"
                style={p.is_me ? { background: "var(--psi-dim)" } : undefined}
              >
                <td className="py-2">
                  <span className="flex items-center gap-2">
                    <RaceTile letter={RACE_LETTER[p.race] ?? "?"} size={17} />
                    <span className={p.is_me ? "font-semibold" : ""}>
                      {p.name}
                      {p.is_computer && (
                        <span className="ml-1.5 text-[10px] uppercase text-[var(--ink-faint)]">bot</span>
                      )}
                    </span>
                    {p.is_winner && (
                      <span className="text-[10px] uppercase tracking-wider text-[var(--vespene)]">
                        win
                      </span>
                    )}
                  </span>
                </td>
                <td className="font-data text-[12px] text-[var(--ink-dim)]">{p.team}</td>
                <td className="font-data text-right tabular-nums">{p.apm ?? "—"}</td>
                <td className="font-data text-right tabular-nums text-[var(--ink-dim)]">
                  {p.eapm ?? "—"}
                </td>
                <td className="font-data pr-1 text-right tabular-nums text-[var(--ink-dim)]">
                  {p.hotkey_pct != null ? `${p.hotkey_pct}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Observations */}
      {observations.length > 0 && (
        <section className="card p-5">
          <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
            Observaciones
          </h3>
          <div className="space-y-2">
            {observations.map((o, i) => (
              <p key={i} className="flex gap-2.5 text-[13px]">
                <span
                  className="mt-[7px] h-[7px] w-[7px] shrink-0 rounded-[2px]"
                  style={{
                    background:
                      o.severity === "warn"
                        ? "var(--energy)"
                        : o.severity === "good"
                          ? "var(--vespene)"
                          : "var(--ink-faint)",
                  }}
                />
                <span className="text-[var(--ink-dim)]">{o.text}</span>
              </p>
            ))}
          </div>
        </section>
      )}

      {/* Charts */}
      {me && (
        <>
          <section className="card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
                Tu ejército producido
              </h3>
              <p className="text-[11px] text-[var(--ink-faint)]">
                área = tu mix · líneas punteadas = supply rival · hover para el detalle
              </p>
            </div>
            <ArmyChart data={armyData} myUnits={myUnitTypes} opponents={oppNames} />
          </section>

          <section className="card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
                Workers y saturación
              </h3>
              <p className="text-[11px] text-[var(--ink-faint)]">
                — workers · - - saturación óptima estimada · líneas azules = expansiones
              </p>
            </div>
            <WorkerChart
              data={workerData}
              expansions={myExpansions.map((e) => ({
                minute: Math.round(e.seconds / 60),
                item: e.item,
              }))}
            />
          </section>
        </>
      )}

      {/* Build orders */}
      <section className="card p-5">
        <h3 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-[var(--ink-dim)]">
          Build orders <span className="normal-case text-[var(--ink-faint)]">(sin workers)</span>
        </h3>
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(ordered.length, 4)}, minmax(0, 1fr))` }}>
          {ordered.map((p) => (
            <div key={p.player_id} className="min-w-0">
              <p className="mb-2 flex items-center gap-1.5 truncate text-[12px] font-medium">
                <RaceTile letter={RACE_LETTER[p.race] ?? "?"} size={15} />
                <span className={p.is_me ? "text-[var(--psi)]" : ""}>{p.name}</span>
              </p>
              <div className="font-data max-h-96 space-y-0.5 overflow-y-auto pr-1 text-[11px] leading-[1.8]">
                {evs
                  .filter((e) => e.player_id === p.player_id && structural(e))
                  .map((e, i) => (
                    <p key={i} className="flex gap-2 whitespace-nowrap">
                      <span className="text-[var(--ink-ghost)]">{fmtTime(e.seconds)}</span>
                      <span
                        className="truncate"
                        style={{
                          color:
                            e.kind === "Upgrade" || e.kind === "Tech"
                              ? "var(--minerals)"
                              : e.kind === "Build" || e.kind === "Building Morph"
                                ? "var(--ink)"
                                : "var(--ink-dim)",
                        }}
                      >
                        {e.item}
                      </span>
                    </p>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
