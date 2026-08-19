"use strict";
/**
 * Simulates ONE game and writes its .bin.gz. Runs as a child process so that a
 * C++ abort inside the WASM, a runaway replay or a memory spike can never take
 * the worker loop down — and so the parent can enforce a hard timeout.
 *
 * The job comes in as JSON on argv[2]:
 *   { gameId, repPath, outPath, players: [{ id, name }] }
 * The result is printed as a single line to stdout:
 *   __RESIM__{"ok":true,"stats":{...}} | __RESIM__{"ok":false,"skip":bool,"error":"..."}
 */
const fs = require("fs");
const path = require("path");
const { simulateReplay } = require("./lib/simulate");

const RESULT_PREFIX = "__RESIM__";
const BWDATA_DIR = process.env.BWDATA_DIR || "/bwdata";

async function main() {
  const job = JSON.parse(process.argv[2]);
  const { buffer, stats } = await simulateReplay({
    gameId: job.gameId,
    repPath: job.repPath,
    bwdataDir: BWDATA_DIR,
    players: job.players,
  });
  await fs.promises.mkdir(path.dirname(job.outPath), { recursive: true });
  const tmp = job.outPath + ".tmp";
  await fs.promises.writeFile(tmp, buffer);
  await fs.promises.rename(tmp, job.outPath); // atomic: readers never see a partial file
  process.stdout.write(RESULT_PREFIX + JSON.stringify({ ok: true, stats }) + "\n");
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stdout.write(
      RESULT_PREFIX +
        JSON.stringify({ ok: false, skip: !!e.skip, error: e && e.message ? e.message : String(e) }) +
        "\n"
    );
    process.exit(e && e.skip ? 3 : 1);
  }
);

module.exports = { RESULT_PREFIX };
