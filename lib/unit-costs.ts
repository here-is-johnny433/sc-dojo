// Mineral/gas cost per UNIT (not per command), keyed by short name — the form
// `shortUnitName()` returns for resim types. Morphed units carry the full chain
// (Lurker = Hydralisk + morph). Buildings are deliberately absent: the combat
// score only values army/worker trades, so proxy cancels and base razes at the
// end of a decided game don't drown the signal.

export const UNIT_COSTS: Record<string, { m: number; g: number }> = {
  // Protoss
  Probe: { m: 50, g: 0 },
  Zealot: { m: 100, g: 0 },
  Dragoon: { m: 125, g: 50 },
  "High Templar": { m: 50, g: 150 },
  "Dark Templar": { m: 125, g: 100 },
  Archon: { m: 100, g: 300 },
  "Dark Archon": { m: 250, g: 200 },
  Reaver: { m: 200, g: 100 },
  Observer: { m: 25, g: 75 },
  Shuttle: { m: 200, g: 0 },
  Scout: { m: 275, g: 125 },
  Corsair: { m: 150, g: 100 },
  Carrier: { m: 350, g: 250 },
  Interceptor: { m: 25, g: 0 },
  Arbiter: { m: 100, g: 350 },
  // Terran
  SCV: { m: 50, g: 0 },
  Marine: { m: 50, g: 0 },
  Firebat: { m: 50, g: 25 },
  Medic: { m: 50, g: 25 },
  Ghost: { m: 25, g: 75 },
  Vulture: { m: 75, g: 0 },
  "Siege Tank": { m: 150, g: 100 },
  "Siege Tank Tank Mode": { m: 150, g: 100 },
  "Siege Tank Siege Mode": { m: 150, g: 100 },
  Goliath: { m: 100, g: 50 },
  Wraith: { m: 150, g: 100 },
  Dropship: { m: 100, g: 100 },
  "Science Vessel": { m: 100, g: 225 },
  Battlecruiser: { m: 400, g: 300 },
  Valkyrie: { m: 250, g: 125 },
  // Zerg (per unit: Zergling/Scourge morph in pairs)
  Drone: { m: 50, g: 0 },
  Zergling: { m: 25, g: 0 },
  Overlord: { m: 100, g: 0 },
  Hydralisk: { m: 75, g: 25 },
  Lurker: { m: 125, g: 125 },
  Mutalisk: { m: 100, g: 100 },
  Scourge: { m: 13, g: 38 },
  Queen: { m: 100, g: 100 },
  Ultralisk: { m: 200, g: 200 },
  Guardian: { m: 150, g: 200 },
  Devourer: { m: 250, g: 150 },
  Defiler: { m: 50, g: 150 },
  "Infested Terran": { m: 100, g: 50 },
};

/** Trade value of one unit; gas weighs more because it mines slower. */
export function unitValue(shortName: string): number {
  const c = UNIT_COSTS[shortName];
  return c ? c.m + 1.5 * c.g : 0;
}
