"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminUser } from "@/lib/admin";

export function AdminUsers({
  initialUsers,
  sessionId,
}: {
  initialUsers: AdminUser[];
  sessionId: number;
}) {
  const router = useRouter();
  const users = initialUsers; // router.refresh() vuelve a renderizar la página con la lista fresca
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", role: "player", password: "" });
  const [aliasDraft, setAliasDraft] = useState<Record<number, string>>({});

  async function send(url: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Error inesperado");
        return false;
      }
      if (typeof data.linkedGames === "number") {
        setNotice(
          data.linkedGames > 0
            ? `Alias vinculado a ${data.linkedGames} partidas ya importadas.`
            : "Alias añadido. Ninguna partida existente usaba ese nombre."
        );
      }
      router.refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    if (await send("/api/admin/users", "POST", form)) {
      setForm({ email: "", name: "", role: "player", password: "" });
      setCreating(false);
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    await send(`/api/admin/users/${id}`, "PATCH", body);
  }

  async function addAlias(id: number) {
    const alias = (aliasDraft[id] ?? "").trim();
    if (!alias) return;
    if (await send(`/api/admin/users/${id}/aliases`, "POST", { alias })) {
      setAliasDraft({ ...aliasDraft, [id]: "" });
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-[12px] text-[var(--supply-red)]">{error}</p>}
      {notice && <p className="text-[12px] text-[var(--psi)]">{notice}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="border-b border-[var(--grid-line)] text-left text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)]">
              <th className="py-2.5 pl-5 font-medium">Jugador</th>
              <th className="font-medium">Rol</th>
              <th className="font-medium">Alias de Battle.net</th>
              <th className="font-medium">Partidas</th>
              <th className="pr-5 text-right font-medium">Estado</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                className="border-b border-[var(--grid-line-soft)] align-top last:border-0"
                style={u.active ? undefined : { opacity: 0.55 }}
              >
                <td className="py-3 pl-5">
                  <p className="font-medium">{u.name}</p>
                  <p className="font-data text-[11px] text-[var(--ink-faint)]">{u.email}</p>
                </td>
                <td className="py-3">
                  <select
                    value={u.role}
                    disabled={busy || u.id === sessionId}
                    onChange={(e) => patch(u.id, { role: e.target.value })}
                    className="text-[12px]"
                  >
                    <option value="player">jugador</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {u.aliases.map((a) => (
                      <span
                        key={a}
                        className="font-data flex items-center gap-1 rounded-full border border-[var(--grid-line)] px-2.5 py-1 text-[11px] text-[var(--ink-dim)]"
                      >
                        {a}
                        <button
                          type="button"
                          disabled={busy}
                          title="Quitar alias"
                          onClick={() =>
                            send(`/api/admin/users/${u.id}/aliases`, "DELETE", { alias: a })
                          }
                          className="text-[var(--ink-ghost)] hover:text-[var(--supply-red)]"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 flex gap-1.5">
                    <input
                      value={aliasDraft[u.id] ?? ""}
                      onChange={(e) => setAliasDraft({ ...aliasDraft, [u.id]: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addAlias(u.id);
                      }}
                      placeholder="nuevo alias"
                      className="w-40 text-[12px]"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => addAlias(u.id)}
                      className="btn px-2.5 py-1 text-[12px]"
                    >
                      Añadir
                    </button>
                  </div>
                </td>
                <td className="font-data py-3 tabular-nums text-[var(--ink-dim)]">{u.games}</td>
                <td className="py-3 pr-5 text-right">
                  <button
                    type="button"
                    disabled={busy || u.id === sessionId}
                    onClick={() => patch(u.id, { active: !u.active })}
                    className="btn px-2.5 py-1 text-[12px]"
                  >
                    {u.active ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating ? (
        <form onSubmit={createUser} className="card grid gap-2 p-5 sm:grid-cols-2">
          <label className="text-[12px] text-[var(--ink-dim)]">
            Correo
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="mt-1 w-full"
            />
          </label>
          <label className="text-[12px] text-[var(--ink-dim)]">
            Nombre
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full"
            />
          </label>
          <label className="text-[12px] text-[var(--ink-dim)]">
            Contraseña inicial
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="mt-1 w-full"
            />
          </label>
          <label className="text-[12px] text-[var(--ink-dim)]">
            Rol
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="mt-1 w-full"
            >
              <option value="player">jugador</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" disabled={busy} className="btn btn-psi">
              Crear jugador
            </button>
            <button type="button" onClick={() => setCreating(false)} className="btn">
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setCreating(true)} className="btn btn-psi">
          Nuevo jugador
        </button>
      )}
    </div>
  );
}
