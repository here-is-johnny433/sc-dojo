"use strict";
/**
 * Reference decoder + sanity check for a DJR1 file.
 *
 *   node resim/verify.js <file.bin.gz> [frame ...]
 *
 * Validates the magic, the header JSON, and that every sample block consumes
 * exactly the bytes its strides say it should — then prints per-player unit
 * counts, economy and a typeId breakdown for the requested frames.
 */
const fs = require("fs");
const zlib = require("zlib");

const UNIT_RECORD_BYTES = 10;

function decode(gzPath) {
  const buf = zlib.gunzipSync(fs.readFileSync(gzPath));
  const magic = buf.toString("ascii", 0, 4);
  if (magic !== "DJR1") throw new Error(`bad magic ${JSON.stringify(magic)}`);
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString("utf8", 8, 8 + headerLen));
  const nPlayers = header.players.length;

  let o = 8 + headerLen;
  const samples = [];
  while (o < buf.length) {
    const frame = buf.readUInt32LE(o);
    o += 4;
    const economy = [];
    for (let i = 0; i < nPlayers; i++) {
      economy.push({
        minerals: buf.readUInt16LE(o),
        gas: buf.readUInt16LE(o + 2),
        supplyUsed: buf.readUInt16LE(o + 4),
        supplyMax: buf.readUInt16LE(o + 6),
      });
      o += 8;
    }
    const unitCount = buf.readUInt16LE(o);
    o += 2;
    if (o + unitCount * UNIT_RECORD_BYTES > buf.length) {
      throw new Error(`sample @frame ${frame} claims ${unitCount} units but the file ends first`);
    }
    const units = [];
    for (let i = 0; i < unitCount; i++) {
      units.push({
        tag: buf.readUInt16LE(o),
        typeId: buf.readUInt16LE(o + 2),
        ownerIdx: buf.readUInt8(o + 4),
        x: buf.readUInt16LE(o + 5),
        y: buf.readUInt16LE(o + 7),
        hpPct: buf.readUInt8(o + 9),
      });
      o += UNIT_RECORD_BYTES;
    }
    samples.push({ frame, economy, units });
  }
  if (o !== buf.length) throw new Error(`trailing bytes: consumed ${o} of ${buf.length}`);
  return { header, samples, rawBytes: buf.length, gzBytes: fs.statSync(gzPath).size };
}

function main() {
  const file = process.argv[2];
  const wanted = process.argv.slice(3).map(Number);
  const { header, samples, rawBytes, gzBytes } = decode(file);

  console.log(`file        ${file}`);
  console.log(`magic       DJR1 ok — raw ${rawBytes} B, gz ${gzBytes} B (${(gzBytes / 1048576).toFixed(2)} MB)`);
  console.log(
    `header      version=${header.version} gameId=${header.gameId} frames=${header.frames} ` +
      `fps=${header.fps} sampleStep=${header.sampleStep}`
  );
  console.log(`sampleCount ${header.sampleCount} declared / ${samples.length} decoded`);
  if (header.sampleCount !== samples.length) throw new Error("sampleCount mismatch");
  console.log(`players     ${header.players.map((p) => `${p.id}:${p.name}`).join("  ")}`);
  console.log(`types       ${Object.keys(header.types).length} distinct`);

  const badOwner = samples.some((s) => s.units.some((u) => u.ownerIdx >= header.players.length));
  console.log(`ownerIdx    ${badOwner ? "OUT OF RANGE" : "all within players[]"}`);

  for (const target of wanted) {
    let best = samples[0];
    for (const s of samples) if (Math.abs(s.frame - target) < Math.abs(best.frame - target)) best = s;
    const secs = (best.frame / header.fps).toFixed(0);
    console.log(`\n--- frame ${best.frame} (~${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}), asked ${target} ---`);
    header.players.forEach((p, idx) => {
      const mine = best.units.filter((u) => u.ownerIdx === idx);
      const e = best.economy[idx];
      const nexus = mine.filter((u) => u.typeId === 154);
      console.log(
        `  [${idx}] id=${p.id} ${p.name.padEnd(13)} units=${String(mine.length).padStart(3)} ` +
          `min=${String(e.minerals).padStart(4)} gas=${String(e.gas).padStart(4)} ` +
          `supply=${e.supplyUsed / 2}/${e.supplyMax / 2}` +
          (nexus.length
            ? `  Nexus x${nexus.length}: ${nexus.map((n) => `(${n.x},${n.y}) hp=${n.hpPct}%`).join(" ")}`
            : "")
      );
    });
    const counts = {};
    for (const u of best.units) counts[u.typeId] = (counts[u.typeId] || 0) + 1;
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, n]) => `${header.types[id].name} x${n}`);
    console.log(`  top types: ${top.join(", ")}`);
  }
}

if (require.main === module) main();
module.exports = { decode };
