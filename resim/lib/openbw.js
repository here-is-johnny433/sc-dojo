"use strict";
/**
 * Minimal Node binding for the OpenBW WASM build shipped by titan-reactor.
 *
 * Everything here was validated by the spike (see README "Capa B"):
 *  - the Emscripten glue is ESM upstream; `vendor/titan.wasm.cjs` is the CJS
 *    conversion (`export default` -> `module.exports`),
 *  - `wasmBinary` must be passed explicitly: the glue takes the browser branch
 *    because Node >= 18 has a global `fetch`, and then fails to parse the URL,
 *  - `quit` must be overridden or Emscripten kills the process silently on a
 *    C++ abort,
 *  - every game asset must be truncated to its first 1/8 (done at extraction
 *    time by `pnpm extract-bwdata`),
 *  - frames are advanced with `_replay_set_value(3, target)` + `_next_frame()`.
 *    `_next_step()` is the sandbox path and does NOT apply replay commands.
 */
const fs = require("fs");
const path = require("path");

const VENDOR = path.join(__dirname, "..", "vendor");
const FILEPATHS = require(path.join(VENDOR, "filepaths.json"));

/** Must match `flatName()` in scripts/extract-bwdata.ts. */
const flatName = (fp) => fp.toLowerCase().replace(/[\\/]/g, "__");

/**
 * Boots the WASM module with the game data files loaded.
 * @param {string} bwdataDir
 */
async function createOpenBW(bwdataDir) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createModule = require(path.join(VENDOR, "titan.wasm.cjs"));
  const wasm = await createModule({
    wasmBinary: fs.readFileSync(path.join(VENDOR, "titan.wasm")),
    noInitialRun: true,
    quit: (_status, e) => {
      throw e;
    },
    print: () => {},
    printErr: () => {},
  });

  const buffers = [];
  const index = Object.create(null);

  wasm.setupCallbacks({
    js_fatal_error: (ptr) => {
      throw new Error("openbw fatal: " + wasm.UTF8ToString(ptr));
    },
    js_pre_main_loop: () => {},
    js_post_main_loop: () => {},
    js_file_size: (i) => buffers[i].byteLength,
    js_read_data: (i, dst, off, size) => {
      const d = buffers[i];
      for (let k = 0; k < size; k++) wasm.HEAP8[dst + k] = d[off + k];
    },
    js_load_done: () => {},
    js_file_index: (ptr) => {
      const i = index[flatName(wasm.UTF8ToString(ptr))];
      return i === undefined ? 9999 : i;
    },
    js_on_replay_frame: () => {},
  });

  for (const fp of FILEPATHS) {
    const key = flatName(fp);
    if (key in index) continue;
    const buf = fs.readFileSync(path.join(bwdataDir, key));
    buffers.push(Int8Array.from(buf));
    index[key] = buffers.length - 1;
  }

  wasm.callMain();
  return wasm;
}

/** Turns an OpenBW numeric exception into a readable Error. */
function openbwError(wasm, e) {
  if (typeof e === "number" && wasm) {
    try {
      const msg = wasm.getExceptionMessage
        ? wasm.getExceptionMessage(e)
        : wasm.UTF8ToString(wasm.HEAPU32[(e >> 2) + 1]);
      return new Error("openbw: " + msg);
    } catch {
      return new Error("openbw: C++ exception " + e);
    }
  }
  return e instanceof Error ? e : new Error(String(e));
}

function loadReplay(wasm, buffer) {
  const ptr = wasm.allocate(buffer, wasm.ALLOC_NORMAL);
  try {
    wasm._load_replay(ptr, buffer.length);
  } finally {
    wasm._free(ptr);
  }
  wasm._replay_set_value(1, 0); // unpause
}

/**
 * Advances the simulation to `target`, applying replay commands.
 * @returns the frame actually reached (may fall short at the end of a replay)
 */
function seekTo(wasm, current, target) {
  wasm._replay_set_value(3, target);
  let stalls = 0;
  let cur = current;
  while (cur < target && stalls < 20) {
    const next = wasm._next_frame();
    if (next === cur) stalls++;
    else stalls = 0;
    cur = next;
  }
  return cur;
}

/**
 * Reads every live unit from the 12 intrusive per-player lists at
 * `_get_buffer(2)` (port of titan-reactor's UnitsBufferViewIterator).
 */
function readUnits(wasm, out) {
  const H32 = wasm.HEAP32;
  const HU32 = wasm.HEAPU32;
  const base = wasm._get_buffer(2);
  out.length = 0;
  for (let p = 0; p < 12; p++) {
    const addr = base + (p << 3);
    const end = HU32[addr >> 2];
    const begin = HU32[(addr >> 2) + 1];
    if (HU32[end >> 2] === end) continue; // empty list
    let cur = begin;
    for (;;) {
      const a32 = (cur >> 2) + 2; // skip the intrusive link base
      const typeAddr = HU32[a32 + 40];
      // titan-reactor's unit id: (index + 1) | (generation % 8) << 13. The
      // generation bits keep the tag distinct when a slot is recycled by a new
      // unit, which is what lets the consumer derive deaths from tag diffs.
      const index = HU32[a32 + 2];
      const generation = HU32[a32 + 69] & 0x7;
      out.push({
        tag: ((index + 1) | (generation << 13)) & 0xffff,
        typeId: H32[typeAddr >> 2],
        owner: H32[a32 + 28],
        x: H32[a32 + 16],
        y: H32[a32 + 17],
        hp: HU32[a32] / 256,
        shields: HU32[a32 + 39] / 256,
      });
      if (cur === end) break;
      cur = HU32[(cur >> 2) + 44];
    }
  }
  return out;
}

/**
 * Per-player economy counters: `_get_buffer(8)` is 8 players x 7 int32
 * (minerals, gas, supplyUsed, supplyMax, workerSupply, armySupply, apm).
 * Supply values are in BW's internal half-units.
 */
const PLAYER_STRUCT_SIZE = 7;
function readEconomy(wasm, slot) {
  const addr = wasm._get_buffer(8) >> 2;
  const o = addr + PLAYER_STRUCT_SIZE * slot;
  const H = wasm.HEAP32;
  return {
    minerals: H[o + 0] | 0,
    gas: H[o + 1] | 0,
    supplyUsed: H[o + 2] | 0,
    supplyMax: H[o + 3] | 0,
  };
}

module.exports = { createOpenBW, openbwError, loadReplay, seekTo, readUnits, readEconomy };
