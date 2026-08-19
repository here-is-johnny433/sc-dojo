import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { replayDetails } from "@/lib/agent-tools";
import { fmtTime } from "@/lib/bw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MODEL = "claude-sonnet-5";

export interface Comment {
  at_seconds: number;
  verdict: "good" | "bad" | "info";
  text: string;
}

const COMMENTARY_TOOL: Anthropic.Tool = {
  name: "emit_commentary",
  description: "Entrega la pista de comentarios del coach para la partida.",
  input_schema: {
    type: "object" as const,
    properties: {
      comments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            at_seconds: { type: "number", description: "Segundo de la partida (tiempo de juego)" },
            verdict: { type: "string", enum: ["good", "bad", "info"] },
            text: { type: "string", description: "Una o dos frases en español, con datos concretos" },
          },
          required: ["at_seconds", "verdict", "text"],
        },
      },
    },
    required: ["comments"],
  },
};

function prompt(duration: number, details: string) {
  return `Eres el coach del Starcraft Dojo analizando un replay de Brood War para tu alumno Stephan (cuentas EdgarallanPulp y Ze_Pulp). Abajo está el detalle completo de la partida en JSON.

Genera entre 8 y 14 comentarios anclados a momentos concretos, que se mostrarán durante la reproducción del replay al llegar su timestamp.

REGLAS:
- at_seconds entre 0 y ${duration} (${fmtTime(duration)}), repartidos por toda la partida, en orden ascendente.
- Cada comentario debe citar un dato verificable del build order o del chat (timing, conteo, unidad, upgrade). Nada genérico.
- verdict: "good" lo que hizo bien, "bad" el error concreto (y qué debió hacer), "info" contexto o lo que hacía el rival.
- Enfócate en Stephan: al menos 8 de los comentarios son sobre su juego.
- Español, tono de coach: directo, concreto, una o dos frases. Sin markdown.
- Devuélvelos con la herramienta emit_commentary.

DATOS DE LA PARTIDA:
${details}`;
}

function parseComments(raw: unknown, duration: number): Comment[] {
  if (!Array.isArray(raw)) return [];
  const out: Comment[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    const at = Math.round(Number(c.at_seconds));
    const text = String(c.text ?? "").trim();
    const verdict = String(c.verdict ?? "info");
    if (!Number.isFinite(at) || !text) continue;
    out.push({
      at_seconds: Math.min(Math.max(at, 0), duration),
      verdict: verdict === "good" || verdict === "bad" ? verdict : "info",
      text: text.slice(0, 600),
    });
  }
  return out.sort((a, b) => a.at_seconds - b.at_seconds);
}

async function listComments(gameId: string): Promise<Comment[]> {
  const r = await db().query(
    "SELECT at_seconds, verdict, text FROM game_commentary WHERE game_id = $1 ORDER BY at_seconds",
    [gameId]
  );
  return r.rows;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{16}$/.test(id)) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }
  return NextResponse.json({ comments: await listComments(id) });
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{16}$/.test(id)) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Falta ANTHROPIC_API_KEY en el .env — créala en console.anthropic.com" },
      { status: 500 }
    );
  }

  const g = await db().query("SELECT duration_seconds FROM games WHERE id = $1", [id]);
  if (!g.rowCount) return NextResponse.json({ error: "partida no encontrada" }, { status: 404 });
  const duration: number = g.rows[0].duration_seconds ?? 0;

  const details = await replayDetails(id);
  if (details.startsWith("ERROR")) {
    return NextResponse.json({ error: details }, { status: 500 });
  }

  let comments: Comment[] = [];
  try {
    const response = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 4000,
      tools: [COMMENTARY_TOOL],
      tool_choice: { type: "tool", name: "emit_commentary" },
      messages: [{ role: "user", content: prompt(duration, details.slice(0, 120_000)) }],
    });
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (toolUse) {
      comments = parseComments((toolUse.input as { comments?: unknown }).comments, duration);
    } else {
      // Fallback: the model answered in prose — pull the first JSON array out of it.
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const match = text.match(/\[[\s\S]*\]/);
      if (match) comments = parseComments(JSON.parse(match[0]), duration);
    }
  } catch (e) {
    return NextResponse.json({ error: `Error del coach: ${(e as Error).message}` }, { status: 502 });
  }

  if (!comments.length) {
    return NextResponse.json({ error: "El coach no devolvió comentarios" }, { status: 502 });
  }

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM game_commentary WHERE game_id = $1", [id]);
    for (const c of comments) {
      await client.query(
        "INSERT INTO game_commentary (game_id, at_seconds, verdict, text) VALUES ($1,$2,$3,$4)",
        [id, c.at_seconds, c.verdict, c.text]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: `No se pudo guardar: ${(e as Error).message}` }, { status: 500 });
  } finally {
    client.release();
  }

  return NextResponse.json({ comments: await listComments(id) });
}
