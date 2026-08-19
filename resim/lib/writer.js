"use strict";
/**
 * DJR1 — the on-disk re-simulation format consumed by the replay viewer.
 * Everything is little-endian; the whole buffer is gzipped on disk.
 *
 *   "DJR1"                            4 bytes, ASCII magic
 *   headerLen                         uint32
 *   header                            headerLen bytes of UTF-8 JSON
 *   payload, one block per sample:
 *     frame                           uint32
 *     per player (header order):      uint16 minerals, uint16 gas,
 *                                     uint16 supplyUsed, uint16 supplyMax
 *                                     (supply in BW half-units, clamped)
 *     unitCount                       uint16
 *     unitCount x 10-byte records:    uint16 tag, uint16 typeId, uint8 ownerIdx,
 *                                     uint16 x, uint16 y, uint8 hpPct
 *
 * Deaths are not stored: the consumer diffs the tag sets of consecutive samples.
 */

const MAGIC = "DJR1";
const UNIT_RECORD_BYTES = 10;

const u16 = (n) => (n < 0 ? 0 : n > 65535 ? 65535 : n | 0);
const u8 = (n) => (n < 0 ? 0 : n > 255 ? 255 : n | 0);

class SampleWriter {
  /**
   * @param {number} playerCount number of economy blocks per sample
   */
  constructor(playerCount) {
    this.playerCount = playerCount;
    this.chunks = [];
    this.sampleCount = 0;
  }

  /**
   * @param {number} frame
   * @param {{minerals:number,gas:number,supplyUsed:number,supplyMax:number}[]} economy
   * @param {{tag:number,typeId:number,ownerIdx:number,x:number,y:number,hpPct:number}[]} units
   */
  push(frame, economy, units) {
    const size = 4 + this.playerCount * 8 + 2 + units.length * UNIT_RECORD_BYTES;
    const b = Buffer.allocUnsafe(size);
    let o = 0;
    b.writeUInt32LE(frame >>> 0, o);
    o += 4;
    for (let i = 0; i < this.playerCount; i++) {
      const e = economy[i] || { minerals: 0, gas: 0, supplyUsed: 0, supplyMax: 0 };
      b.writeUInt16LE(u16(e.minerals), o);
      b.writeUInt16LE(u16(e.gas), o + 2);
      b.writeUInt16LE(u16(e.supplyUsed), o + 4);
      b.writeUInt16LE(u16(e.supplyMax), o + 6);
      o += 8;
    }
    b.writeUInt16LE(u16(units.length), o);
    o += 2;
    for (const u of units) {
      b.writeUInt16LE(u16(u.tag), o);
      b.writeUInt16LE(u16(u.typeId), o + 2);
      b.writeUInt8(u8(u.ownerIdx), o + 4);
      b.writeUInt16LE(u16(u.x), o + 5);
      b.writeUInt16LE(u16(u.y), o + 7);
      b.writeUInt8(u8(u.hpPct), o + 9);
      o += UNIT_RECORD_BYTES;
    }
    this.chunks.push(b);
    this.sampleCount++;
  }

  /**
   * @param {object} header the JSON header, `sampleCount` is filled in here
   * @returns {Buffer} the uncompressed DJR1 buffer
   */
  finish(header) {
    const json = Buffer.from(
      JSON.stringify({ ...header, sampleCount: this.sampleCount }),
      "utf8"
    );
    const head = Buffer.allocUnsafe(8);
    head.write(MAGIC, 0, "ascii");
    head.writeUInt32LE(json.length, 4);
    return Buffer.concat([head, json, ...this.chunks]);
  }
}

module.exports = { SampleWriter, MAGIC, UNIT_RECORD_BYTES };
