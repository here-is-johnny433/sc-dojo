import { NextResponse } from "next/server";
import { buildViewerData } from "@/lib/viewer-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{16}$/.test(id)) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }
  try {
    const data = await buildViewerData(id);
    if (!data) return NextResponse.json({ error: "partida no encontrada" }, { status: 404 });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo leer el replay parseado: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
