"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
}

interface Message {
  id: number;
  role: "user" | "assistant";
  content: ContentBlock[];
}

interface Conversation {
  id: number;
  title: string;
}

function renderText(text: string) {
  // minimal markdown: bold, inline code, headers, list dashes
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const html = line
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code style='font-family:var(--font-plex-mono);font-size:12px;background:var(--hud);padding:1px 5px;border-radius:4px'>$1</code>");
    const isHeader = /^#{1,3} /.test(line);
    return (
      <p
        key={i}
        className={isHeader ? "mt-2 font-semibold" : line.startsWith("- ") ? "pl-3" : ""}
        style={{ minHeight: line.trim() ? undefined : 8 }}
        dangerouslySetInnerHTML={{ __html: isHeader ? html.replace(/^#+ /, "") : html }}
      />
    );
  });
}

export function ChatUI() {
  const params = useSearchParams();
  const gameId = params.get("game");
  const at = params.get("t"); // moment picked in the replay viewer, mm:ss
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(
    gameId && at
      ? `En el minuto ${at} de esta partida, ¿qué estaba pasando y qué debí hacer distinto?`
      : gameId
        ? "Analiza esta partida a fondo: ¿qué hice bien, qué hice mal y qué debo cambiar?"
        : ""
  );
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/chat");
    const body = await res.json();
    setConversations(body.conversations ?? []);
  }, []);

  const loadMessages = useCallback(async (id: number) => {
    const res = await fetch(`/api/chat?conversationId=${id}`);
    const body = await res.json();
    setMessages(body.messages ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState happens after an async fetch, not synchronously
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMessages((m) => [
      ...m,
      { id: -1, role: "user", content: [{ type: "text", text }] },
    ]);
    setActivity("pensando");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: convId ?? undefined,
          message: text,
          gameId: convId ? undefined : gameId ?? undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Error");
      } else {
        setConvId(body.conversationId);
        await loadMessages(body.conversationId);
        loadConversations();
      }
    } catch {
      setError("Fallo de red");
    } finally {
      setBusy(false);
      setActivity(null);
    }
  }

  const visible = messages.filter((m) =>
    m.content.some((b) => b.type === "text" && b.text?.trim())
  );

  return (
    <div className="flex gap-4" style={{ height: "calc(100vh - 120px)" }}>
      {/* Conversations rail */}
      <aside className="hidden w-56 shrink-0 flex-col gap-1 md:flex">
        <button
          onClick={() => {
            setConvId(null);
            setMessages([]);
            setError(null);
          }}
          className="btn btn-psi mb-2 justify-center"
        >
          Nueva conversación
        </button>
        <div className="space-y-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setConvId(c.id);
                loadMessages(c.id);
              }}
              className="w-full truncate rounded-md px-3 py-2 text-left text-[12px] transition-colors"
              style={
                convId === c.id
                  ? { background: "var(--hud)", color: "var(--ink)" }
                  : { color: "var(--ink-dim)" }
              }
            >
              {c.title}
            </button>
          ))}
        </div>
      </aside>

      {/* Chat */}
      <div className="card flex min-w-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {visible.length === 0 && !busy && (
            <div className="mx-auto mt-16 max-w-md text-center">
              <p className="font-data text-[11px] uppercase tracking-[0.25em] text-[var(--psi)]">
                Coach
              </p>
              <h2 className="mb-2 mt-1 text-lg font-semibold">¿En qué entrenamos hoy?</h2>
              <p className="text-[13px] text-[var(--ink-dim)]">
                Pídeme un diagnóstico, el análisis de una partida, o pregúntame cómo
                counterear lo que te está ganando.
              </p>
              <div className="mt-5 flex flex-col gap-2">
                {[
                  "Dame un diagnóstico: ¿cuál es mi mayor debilidad?",
                  "¿Cómo me fue en mis últimas 5 partidas?",
                  "Proponme un objetivo de entrenamiento",
                ].map((s) => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    className="btn justify-center text-[12px]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {visible.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              <div
                className="max-w-[85%] rounded-xl px-4 py-2.5 text-[13.5px] leading-relaxed"
                style={
                  m.role === "user"
                    ? { background: "var(--psi-dim)", color: "var(--ink)" }
                    : { background: "var(--hud)", color: "var(--ink)" }
                }
              >
                {m.content
                  .filter((b) => b.type === "text" && b.text?.trim())
                  .map((b, j) => (
                    <div key={j}>{renderText(b.text!)}</div>
                  ))}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-[12px] text-[var(--ink-faint)]">
              <span className="inline-block h-[8px] w-[8px] animate-pulse rounded-[2px] bg-[var(--psi)]" />
              <span className="font-data">{activity ?? "pensando"}…</span>
            </div>
          )}
          {error && <p className="text-[12px] text-[var(--supply-red)]">{error}</p>}
          <div ref={bottomRef} />
        </div>
        <div className="border-t border-[var(--grid-line)] p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Pregúntale a tu coach…"
              className="flex-1"
              disabled={busy}
            />
            <button type="submit" disabled={busy || !input.trim()} className="btn btn-psi">
              Enviar
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
