"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogoSC } from "@/components/LogoSC";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Error de autenticación");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <h1 className="mb-1 flex items-center gap-3">
          <LogoSC height={18} />
          <span className="text-2xl font-bold tracking-tight">DOJO</span>
        </h1>
        <p className="mb-6 text-[13px] text-[var(--ink-dim)]">
          Tu sala de entrenamiento de Brood War.
        </p>
        <label className="mb-1.5 block text-[12px] font-medium text-[var(--ink-dim)]">
          Contraseña
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mb-4 w-full"
        />
        {error && (
          <p className="mb-4 text-[12px] text-[var(--supply-red)]">{error}</p>
        )}
        <button type="submit" disabled={busy || !password} className="btn btn-psi w-full justify-center">
          {busy ? "Entrando…" : "Entrar al dojo"}
        </button>
      </form>
    </main>
  );
}
