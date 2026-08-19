import { NextRequest, NextResponse } from "next/server";
import { ingestReplay } from "@/lib/ingest";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_SIZE = 2 * 1024 * 1024; // .rep files are typically < 500 KB

export async function POST(req: NextRequest) {
  // Auth (session cookie or upload token) is enforced by middleware.
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "campo 'file' requerido" }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".rep")) {
    return NextResponse.json({ error: "solo archivos .rep" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "archivo demasiado grande" }, { status: 413 });
  }

  const source = (form?.get("source") as string) || "upload";
  const safeSource = ["autosave-mac", "autosave-win", "upload"].includes(source)
    ? source
    : "upload";

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await ingestReplay(buffer, {
    fileName: path_basename(file.name),
    source: safeSource,
  });

  const status = result.status === "error" ? 422 : 200;
  return NextResponse.json(result, { status });
}

// Never trust client-provided paths; keep only the basename.
function path_basename(name: string): string {
  return name.split(/[\\/]/).pop() || "replay.rep";
}
