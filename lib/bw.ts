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

export const RACE_LETTER: Record<string, string> = {
  Protoss: "P",
  Terran: "T",
  Zerg: "Z",
};
