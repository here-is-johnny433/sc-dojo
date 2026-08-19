"use strict";
/**
 * Static per-unit-type data, read from the extracted `arr/units.dat`.
 *
 * units.dat is column-major: every field is an array of `count` entries, laid
 * out back to back. The byte offsets below are the running sum of the field
 * sizes in the canonical 1.16 layout (a few fields only cover a sub-range of
 * unit ids, hence the 106/96-entry columns). Verified against the extracted
 * file: total length 19876 B, Marine hp 40, Nexus hp/shields 750, CC hp 1500.
 */
const fs = require("fs");
const path = require("path");

const UNIT_NAMES = require("./unit-names.json");
const COUNT = 228;

const OFF = {
  shieldsEnabled: 2472, // u8  [228]
  shields: 2700, // u16 [228]
  hp: 3156, // u32 [228], fixed point (>> 8)
  specialAbilityFlags: 7032, // u32 [228], bit 0x1 = Building
  unitSize: 8628, // u8  [228], 1 small / 2 medium / 3 large / 4 independent
  placement: 11284, // u16 pairs [228] (width, height) in pixels
};

/** Rendering size bucket for the viewer: 0 small, 1 medium, 2 large. */
function sizeBucket(building, placementW, placementH) {
  if (building) return 2;
  const dim = Math.max(placementW, placementH);
  if (dim <= 24) return 0; // marine 17, probe 23
  if (dim <= 56) return 1; // dragoon/tank 32, overlord 50
  return 2; // carrier 64, battlecruiser 80
}

let cache = null;

/**
 * @param {string} bwdataDir directory produced by `pnpm extract-bwdata`
 * @returns {{name:string,building:boolean,size:number,maxHp:number,maxShields:number}[]}
 */
function loadUnitTypes(bwdataDir) {
  if (cache) return cache;
  const buf = fs.readFileSync(path.join(bwdataDir, "arr__units.dat"));
  if (buf.length < 19876) {
    throw new Error(
      `arr__units.dat is ${buf.length} B, expected >= 19876 — bad/incomplete bwdata dir ${bwdataDir}`
    );
  }
  const types = [];
  for (let i = 0; i < COUNT; i++) {
    const flags = buf.readUInt32LE(OFF.specialAbilityFlags + 4 * i);
    const building = (flags & 0x1) !== 0;
    const w = buf.readUInt16LE(OFF.placement + 4 * i);
    const h = buf.readUInt16LE(OFF.placement + 4 * i + 2);
    const hasShields = buf.readUInt8(OFF.shieldsEnabled + i) !== 0;
    types.push({
      name: UNIT_NAMES[i] || `Unknown ${i}`,
      building,
      size: sizeBucket(building, w, h),
      maxHp: buf.readUInt32LE(OFF.hp + 4 * i) >> 8,
      maxShields: hasShields ? buf.readUInt16LE(OFF.shields + 2 * i) : 0,
      unitSize: buf.readUInt8(OFF.unitSize + i),
    });
  }
  cache = types;
  return types;
}

/** Resources & doodads that must never reach the output file. */
const NEUTRAL_TYPE_IDS = new Set([
  176, 177, 178, // mineral fields
  188, // vespene geyser
  220, 221, 222, 223, 224, 225, 226, 227, // mineral/gas clusters
]);

module.exports = { loadUnitTypes, NEUTRAL_TYPE_IDS, UNIT_NAMES };
