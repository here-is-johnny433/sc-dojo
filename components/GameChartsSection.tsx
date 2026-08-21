// Todas las gráficas de una partida — datos reales (re-simulación) y estimados
// por comandos — agrupadas para la página del replay. Server component: lee la
// serie del dump en el servidor.

import { WORKERS, RESOURCE_DEPOTS } from "@/lib/bw";
import { gameSeries } from "@/lib/game-series";
import { ArmyChart, WorkerChart, ArmyMinute, WorkerMinute } from "@/components/GameCharts";
import { RealCharts } from "@/components/RealCharts";

interface Ev {
  player_id: number;
  seconds: number;
  kind: string;
  item: string;
  supply_cost: number | null;
}

interface PlayerRow {
  player_id: number;
  name: string;
  team: number;
  user_id: number | null;
}

export async function GameChartsSection({
  gameId,
  viewerUserId,
  durationSeconds,
  players,
  events,
}: {
  gameId: string;
  viewerUserId: number;
  durationSeconds: number;
  players: PlayerRow[];
  events: Ev[];
}) {
  const series = await gameSeries(gameId, viewerUserId);
  const me = players.find((p) => Number(p.user_id) === viewerUserId) ?? null;
  const minutes = Math.max(1, Math.ceil(durationSeconds / 60));

  // --- Army chart data: my stacked unit mix + opponents' total supply lines ---
  const myArmyEvents = me
    ? events.filter(
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
      row[p.name] = events
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
    ? events
        .filter(
          (e) =>
            e.player_id === me.player_id &&
            WORKERS.has(e.item) &&
            (e.kind === "Train" || e.kind === "Unit Morph")
        )
        .map((e) => e.seconds)
    : [];
  const myExpansions = me
    ? events.filter(
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

  return (
    <div className="space-y-5">
      {/* Real data — re-simulation (layer B) */}
      {series && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--ink)]">
              Datos reales <span className="text-[var(--ink-faint)]">(re-simulación)</span>
            </h2>
            <p className="text-[11px] text-[var(--ink-faint)]">
              {series.hasResim
                ? "medido en la re-simulación OpenBW, no estimado por comandos"
                : `El resto de gráficas reales aparecerán cuando termine la re-simulación (estado: ${series.resimStatus}).`}
            </p>
          </div>
          <RealCharts series={series} />
        </section>
      )}

      {/* Command-estimated charts */}
      {me && (
        <>
          <h2 className="pt-2 text-[13px] font-semibold uppercase tracking-wider text-[var(--ink)]">
            Estimado por comandos
          </h2>
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
    </div>
  );
}
