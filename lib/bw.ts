// Static Brood War data used to derive metrics from replay commands.

export const FPS = 23.81; // "Fastest" game speed: frames per real second

export const framesToSeconds = (f: number) => Math.round(f / FPS);

export const fmtTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export const WORKERS = new Set(["Probe", "SCV", "Drone"]);

export const RESOURCE_DEPOTS = new Set(["Nexus", "Command Center", "Hatchery"]);

export const BUILD_KINDS = new Set([
  "Train",
  "Build",
  "Unit Morph",
  "Building Morph",
  "Upgrade",
  "Tech",
]);

// Supply cost per train/morph COMMAND (Zerglings/Scourge come in pairs per morph).
export const SUPPLY_COST: Record<string, number> = {
  // Protoss
  Probe: 1, Zealot: 2, Dragoon: 2, "High Templar": 2, "Dark Templar": 2,
  Reaver: 4, Observer: 1, Shuttle: 2, Scout: 3, Corsair: 2, Carrier: 6, Arbiter: 4,
  // Terran
  SCV: 1, Marine: 1, Firebat: 1, Medic: 1, Ghost: 1, Vulture: 2,
  "Siege Tank": 2, Goliath: 2, Wraith: 2, Dropship: 2, "Science Vessel": 2,
  Battlecruiser: 6, Valkyrie: 3,
  // Zerg (per morph command)
  Drone: 1, Zergling: 1, Overlord: 0, Hydralisk: 1, Lurker: 2, Mutalisk: 2,
  Scourge: 1, Queen: 2, Ultralisk: 4, Guardian: 2, Devourer: 2, Defiler: 2,
  "Infested Terran": 1,
};

// Approximate build times in seconds at Fastest — used by the replay viewer to
// fade a structure in from its Build command; precision is not critical.
export const BUILDING_SECONDS: Record<string, number> = {
  // Protoss
  Pylon: 19, Gateway: 38, Assimilator: 25, "Cybernetics Core": 38, Forge: 25,
  "Photon Cannon": 31, "Shield Battery": 19, Nexus: 75, "Robotics Facility": 50,
  Stargate: 50, "Citadel of Adun": 38, "Templar Archives": 44, Observatory: 19,
  "Robotics Support Bay": 19, "Fleet Beacon": 38, "Arbiter Tribunal": 44,
  // Terran
  "Command Center": 75, "Supply Depot": 25, Refinery: 25, Barracks: 50, Bunker: 19,
  "Engineering Bay": 38, "Missile Turret": 19, Academy: 50, Factory: 50, Starport: 44,
  "Science Facility": 38, Armory: 50, "Comsat Station": 25, "Nuclear Silo": 50,
  "Machine Shop": 25, "Control Tower": 25, "Covert Ops": 25, "Physics Lab": 25,
  // Zerg
  Hatchery: 75, "Creep Colony": 13, Extractor: 25, "Spawning Pool": 50,
  "Evolution Chamber": 25, "Hydralisk Den": 25, "Sunken Colony": 13, "Spore Colony": 13,
  Lair: 63, Spire: 75, "Queen's Nest": 38, "Nydus Canal": 25, Hive: 63,
  "Greater Spire": 63, "Defiler Mound": 38, "Ultralisk Cavern": 50,
};

// Approximate unit train/morph times in seconds at Fastest — drives the live
// production queue in the replay console; precision is not critical.
export const UNIT_SECONDS: Record<string, number> = {
  // Protoss
  Probe: 13, Zealot: 25, Dragoon: 32, "High Templar": 34, "Dark Templar": 32,
  Reaver: 44, Observer: 27, Shuttle: 38, Scout: 50, Corsair: 25, Carrier: 88,
  Arbiter: 100,
  // Terran
  SCV: 13, Marine: 15, Firebat: 15, Medic: 19, Ghost: 32, Vulture: 19,
  "Siege Tank": 31, Goliath: 25, Wraith: 38, Dropship: 31, "Science Vessel": 50,
  Battlecruiser: 84, Valkyrie: 31,
  // Zerg
  Drone: 13, Zergling: 18, Overlord: 25, Hydralisk: 18, Lurker: 25,
  Mutalisk: 25, Scourge: 19, Queen: 31, Ultralisk: 38, Guardian: 25,
  Devourer: 25, Defiler: 31, "Infested Terran": 25,
};

/** Upgrades/research mostly run 60–170s; one middle value keeps the bar honest. */
export const RESEARCH_SECONDS = 100;

export const RACE_LETTER: Record<string, string> = {
  Protoss: "P",
  Terran: "T",
  Zerg: "Z",
};
