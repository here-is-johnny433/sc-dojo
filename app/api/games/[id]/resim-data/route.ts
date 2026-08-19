import fs from "fs/promises";
import { NextResponse } from "next/server";
import { resimFilePath } from "@/lib/resim-format";
import { resimStatus } from "@/lib/viewer-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves the OpenBW re-simulation dump for a game, still gzipped — the browser
 * inflates it for free. 404 carries the worker's status so the viewer can say
 * whether the units are coming or will never come.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{16}$/.test(id)) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }

  let gz: Buffer;
  try {
    gz = await fs.readFile(resimFilePath(id));
  } catch {
    return NextResponse.json({ status: await resimStatus(id) }, { status: 404 });
  }

  return new Response(new Uint8Array(gz), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "gzip",
      "Content-Length": String(gz.byteLength),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
