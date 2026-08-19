import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { AGENT_TOOLS, executeTool } from "@/lib/agent-tools";

export const runtime = "nodejs";
export const maxDuration = 120;

const MODEL = "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 10;

const SYSTEM_PROMPT = `Eres el coach del Starcraft Dojo: un entrenador experto de StarCraft: Brood War Remastered. Tu alumno es Stephan (cuentas: EdgarallanPulp y Ze_Pulp), juega Protoss, mayormente 2v2 con amigos. Hablas español, directo y motivador, como un coach de verdad: concreto, con números, sin paja.

Conoces a fondo Brood War: builds estándar por matchup, counters (qué unidad frena qué), timings, macro (workers constantes, expansiones, gastar minerales), micro, y cómo se entrena de verdad.

METODOLOGÍA (ciclo dojo — práctica deliberada):
1. Diagnóstico: analiza sus partidas con datos reales (query_db, get_replay_details).
2. UN solo foco a la vez: crea un objetivo medible con create_goal (nunca más de uno activo).
3. Recetas de práctica: ejercicios concretos, incluso vs computadora (esas partidas se marcan como práctica y también se evalúan).
4. Cada replay nuevo se evalúa automáticamente contra el objetivo activo (goal_checks).
5. Cuando la racha se cumpla, cierra el objetivo (complete_goal), celebra con números, guarda el progreso en una nota, y rediagnostica.

MEMORIA:
- AL INICIO de cada conversación: llama list_notes y get_active_goal para recordar contexto y progreso.
- Guarda con save_note los patrones que detectes, consejos importantes que des, y avances (área 'progress').
- Compara periodos ("en marzo tu APM era X, hoy es Y") para mostrar progreso real.

DATOS:
- Los replays de BW guardan comandos, no estado: "ejército producido" es producción acumulada, no ejército vivo. Sé honesto con esa limitación.
- Las duraciones/timestamps ya están en segundos de juego (velocidad Fastest).
- En v_my_games, cada fila es una partida SUYA con sus stats (apm, eapm, hotkey_pct, i_won, my_matchup).

FORMATO: respuestas concisas en markdown. Usa números y timestamps concretos. Cuando propongas un objetivo o cierres uno, explica por qué. Si te piden analizar una partida, usa get_replay_details y señala 2-3 cosas accionables, no veinte.`;

interface ChatBody {
  conversationId?: number;
  message?: string;
  gameId?: string;
}

export async function GET(req: NextRequest) {
  const convId = req.nextUrl.searchParams.get("conversationId");
  if (convId) {
    const messages = await db().query(
      "SELECT id, role, content, created_at FROM chat_messages WHERE conversation_id = $1 ORDER BY id",
      [Number(convId)]
    );
    return NextResponse.json({ messages: messages.rows });
  }
  const conversations = await db().query(
    `SELECT c.id, c.title, c.created_at,
            (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.conversation_id = c.id) AS last_at
     FROM chat_conversations c ORDER BY last_at DESC NULLS LAST LIMIT 30`
  );
  return NextResponse.json({ conversations: conversations.rows });
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Falta ANTHROPIC_API_KEY en el .env — créala en console.anthropic.com" },
      { status: 500 }
    );
  }
  const body = (await req.json().catch(() => ({}))) as ChatBody;
  const text = (body.message ?? "").trim();
  if (!text) return NextResponse.json({ error: "mensaje vacío" }, { status: 400 });

  // Create or reuse the conversation.
  let conversationId = body.conversationId;
  if (!conversationId) {
    const r = await db().query(
      "INSERT INTO chat_conversations (title) VALUES ($1) RETURNING id",
      [text.slice(0, 80)]
    );
    conversationId = r.rows[0].id as number;
  }

  const userContent: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: body.gameId ? `${text}\n\n[Contexto: partida game_id=${body.gameId}]` : text,
    },
  ];
  await db().query(
    "INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1,'user',$2)",
    [conversationId, JSON.stringify(userContent)]
  );

  // Rebuild history (content blocks preserve prior tool_use/tool_result pairs).
  const history = await db().query(
    "SELECT role, content FROM chat_messages WHERE conversation_id = $1 ORDER BY id",
    [conversationId]
  );
  const messages: Anthropic.MessageParam[] = history.rows.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const anthropic = new Anthropic();
  const toolActivity: string[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        messages,
      });

      await db().query(
        "INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1,'assistant',$2)",
        [conversationId, JSON.stringify(response.content)]
      );
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        const answer = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return NextResponse.json({ conversationId, answer, toolActivity });
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        toolActivity.push(block.name);
        const result = await executeTool(block.name, block.input as Record<string, unknown>);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.slice(0, 80_000),
        });
      }
      await db().query(
        "INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1,'user',$2)",
        [conversationId, JSON.stringify(results)]
      );
      messages.push({ role: "user", content: results });
    }
    return NextResponse.json({
      conversationId,
      answer: "Me quedé sin rondas de herramientas — intenta preguntarme de nuevo.",
      toolActivity,
    });
  } catch (e) {
    return NextResponse.json(
      { conversationId, error: `Error del agente: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
