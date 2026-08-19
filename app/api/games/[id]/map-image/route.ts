import { NextResponse } from "next/server";
import { mapImage } from "@/lib/map-render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The map's real terrain as a PNG (4 px per tile), painted from the replay's
 * MTXM tiles plus the SC:R tileset graphics and cached on disk. 404 whenever
 * either half is missing — the viewer then keeps its flat background.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{16}$/.test(id)) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }

  let png: Buffer | null;
  try {
    png = await mapImage(id);
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo pintar el mapa: ${(e as Error).message}` },
      { status: 500 }
    );
  }
  if (!png) {
    return NextResponse.json(
      { error: "sin terreno para esta partida (replay sin tiles o tileset ausente)" },
      { status: 404 }
    );
  }

  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
