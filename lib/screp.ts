import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

function screpBinary(): string {
  return process.env.SCREP_PATH || path.join(os.homedir(), "go", "bin", "screp");
}

export interface ScrepPlayer {
  SlotID: number;
  ID: number;
  Type: { Name: string; ID: number };
  Race: { Name: string };
  Team: number;
  Name: string;
  Observer: boolean;
}

export interface ScrepCmd {
  Frame: number;
  PlayerID: number;
  Type: { Name: string; ID: number };
  Unit?: { Name: string };
  Upgrade?: { Name: string };
  Tech?: { Name: string };
  Order?: { Name: string };
  Pos?: { X: number; Y: number };
}

export interface ScrepResult {
  Header: {
    Frames: number;
    StartTime: string;
    Title: string;
    Host: string;
    Map: string;
    MapWidth: number;
    MapHeight: number;
    Type: { Name: string };
    Players: ScrepPlayer[];
  };
  Commands: { Cmds: ScrepCmd[] };
  MapData: unknown;
  Computed: {
    WinnerTeam: number;
    ChatCmds: { Frame: number; PlayerID: number; Message: string }[] | null;
    PlayerDescs: {
      PlayerID: number;
      APM: number;
      EAPM: number;
      CmdCount: number;
      StartLocation: { X: number; Y: number };
    }[];
  };
}

// Parses a .rep buffer by writing it to a temp file and running screp.
export async function parseReplay(buffer: Buffer): Promise<ScrepResult> {
  const tmp = path.join(
    os.tmpdir(),
    `dojo-${crypto.randomBytes(8).toString("hex")}.rep`
  );
  await fs.writeFile(tmp, buffer);
  try {
    const { stdout } = await execFileAsync(
      screpBinary(),
      // -maptiles adds MapData.Tiles (the MTXM terrain), which lib/map-render.ts
      // paints as the replay viewer's background.
      ["-cmds", "-map", "-mapres", "-maptiles", tmp],
      { maxBuffer: 256 * 1024 * 1024, timeout: 30_000 }
    );
    return JSON.parse(stdout) as ScrepResult;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
