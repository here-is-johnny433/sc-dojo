"use strict";
/**
 * Re-simulates one replay with OpenBW and produces the gzipped DJR1 buffer.
 */
const fs = require("fs");
const zlib = require("zlib");
const { parseReplay, writeReplay, ChkDowngrader } = require("process-replay");

const bw = require("./openbw");
const { loadUnitTypes, NEUTRAL_TYPE_IDS } = require("./unit-data");
const { SampleWriter } = require("./writer");

const FPS = 23.81; // BW "fastest" game speed
const SAMPLE_STEP = 12; // ~2 samples per second of game time
const FORMAT_VERSION = 1;

/**
 * @param {Buffer} repBuffer raw SC:R .rep
 * @returns {Promise<{header:import("process-replay").ReplayHeader, downgraded:Buffer}>}
 */
async function prepareReplay(repBuffer) {
  const rep = await parseReplay(repBuffer);
  const chk = new ChkDowngrader().downgrade(rep.chk.slice(0));
  const downgraded = writeReplay(rep.rawHeader, rep.rawCmds, chk, rep.limits);
  return { header: rep.header, downgraded };
}

/** OpenBW does not implement the campaign/computer AI — those replays abort. */
function hasComputerPlayer(header) {
  return header.players.some((p) => p.isComputer && p.name);
}

/**
 * Bridges OpenBW unit owners (which follow process-replay's slot ids) to the
 * screp PlayerIDs the rest of the platform uses. Names are the only stable
 * bridge: screp renumbers players, e.g. on Dark Continent screp calls Ze_Pulp
 * PlayerID 0 while the replay slot (and therefore the OpenBW owner) is 1.
 *
 * @param {object} header process-replay header
 * @param {{id:number,name:string}[]} screpPlayers ordered as they will appear in the file
 * @returns {{ownerToIdx:Int16Array, unmatched:string[]}}
 */
function mapOwners(header, screpPlayers) {
  const ownerToIdx = new Int16Array(16).fill(-1);
  const byName = new Map();
  for (const p of header.players) {
    if (p.name) byName.set(p.name.trim().toLowerCase(), p.id);
  }
  const unmatched = [];
  screpPlayers.forEach((sp, idx) => {
    const owner = byName.get((sp.name || "").trim().toLowerCase());
    if (owner === undefined) {
      // Fall back to identity: better a plausible mapping than dropping a player.
      if (sp.id >= 0 && sp.id < 16 && ownerToIdx[sp.id] === -1) ownerToIdx[sp.id] = idx;
      unmatched.push(sp.name);
    } else {
      ownerToIdx[owner] = idx;
    }
  });
  return { ownerToIdx, unmatched };
}

/**
 * @param {object} opts
 * @param {string} opts.gameId
 * @param {string} opts.repPath
 * @param {string} opts.bwdataDir
 * @param {{id:number,name:string}[]} opts.players screp players, output order
 * @returns {Promise<{buffer:Buffer, stats:object}>}
 */
async function simulateReplay(opts) {
  const { gameId, repPath, bwdataDir, players } = opts;
  const t0 = Date.now();

  const { header, downgraded } = await prepareReplay(fs.readFileSync(repPath));
  if (hasComputerPlayer(header)) {
    const err = new Error("replay contains a Computer player (OpenBW has no ComputerAI)");
    err.skip = true;
    throw err;
  }

  const types = loadUnitTypes(bwdataDir);
  const { ownerToIdx, unmatched } = mapOwners(header, players);
  const tPrep = Date.now() - t0;

  const t1 = Date.now();
  const wasm = await bw.createOpenBW(bwdataDir);
  const tInit = Date.now() - t1;

  const t2 = Date.now();
  let frames;
  const writer = new SampleWriter(players.length);
  const rawUnits = [];
  const outUnits = [];
  const economy = [];
  const typesUsed = new Set();

  try {
    bw.loadReplay(wasm, downgraded);
    frames = header.frameCount;

    let cur = 0;
    for (let target = 0; target <= frames; target += SAMPLE_STEP) {
      if (target > 0) {
        const reached = bw.seekTo(wasm, cur, target);
        if (reached === cur) break; // simulation ended early
        cur = reached;
      }

      economy.length = 0;
      for (let i = 0; i < players.length; i++) economy.push({ minerals: 0, gas: 0, supplyUsed: 0, supplyMax: 0 });
      for (let owner = 0; owner < 8; owner++) {
        const idx = ownerToIdx[owner];
        if (idx < 0) continue;
        const e = bw.readEconomy(wasm, owner);
        // OpenBW's player buffer reports supply in display units; the DJR1
        // contract carries BW's internal half-units.
        economy[idx] = {
          minerals: e.minerals,
          gas: e.gas,
          supplyUsed: e.supplyUsed * 2,
          supplyMax: e.supplyMax * 2,
        };
      }

      bw.readUnits(wasm, rawUnits);
      outUnits.length = 0;
      for (const u of rawUnits) {
        const idx = u.owner < 16 ? ownerToIdx[u.owner] : -1;
        if (idx < 0) continue; // neutral player / unmapped slot
        if (NEUTRAL_TYPE_IDS.has(u.typeId)) continue; // minerals, geysers
        const t = types[u.typeId];
        const max = t ? t.maxHp + t.maxShields : 0;
        const hpPct = max > 0 ? Math.round(((u.hp + u.shields) / max) * 100) : 100;
        outUnits.push({
          tag: u.tag,
          typeId: u.typeId,
          ownerIdx: idx,
          x: u.x,
          y: u.y,
          hpPct: hpPct > 100 ? 100 : hpPct < 0 ? 0 : hpPct,
        });
        typesUsed.add(u.typeId);
      }
      writer.push(cur, economy, outUnits);
    }
  } catch (e) {
    throw bw.openbwError(wasm, e);
  }
  const tSim = Date.now() - t2;

  const typeTable = {};
  for (const id of [...typesUsed].sort((a, b) => a - b)) {
    const t = types[id] || { name: `Unknown ${id}`, building: false, size: 1 };
    typeTable[id] = { name: t.name, building: t.building, size: t.size };
  }

  const raw = writer.finish({
    version: FORMAT_VERSION,
    gameId,
    frames,
    fps: FPS,
    sampleStep: SAMPLE_STEP,
    players: players.map((p) => ({ id: p.id, name: p.name })),
    types: typeTable,
  });

  const t3 = Date.now();
  const buffer = zlib.gzipSync(raw, { level: 6 });
  return {
    buffer,
    stats: {
      frames,
      sampleCount: writer.sampleCount,
      rawBytes: raw.length,
      gzBytes: buffer.length,
      types: typesUsed.size,
      unmatchedPlayers: unmatched,
      ms: { prepare: tPrep, wasmInit: tInit, simulate: tSim, gzip: Date.now() - t3 },
    },
  };
}

module.exports = { simulateReplay, prepareReplay, hasComputerPlayer, mapOwners, SAMPLE_STEP, FPS };
