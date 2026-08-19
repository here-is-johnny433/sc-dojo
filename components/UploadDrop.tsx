"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface UploadState {
  total: number;
  done: number;
  imported: number;
  duplicates: number;
  errors: string[];
}

export function UploadDrop() {
  const [drag, setDrag] = useState(false);
  const [state, setState] = useState<UploadState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const reps = files.filter((f) => f.name.toLowerCase().endsWith(".rep"));
      if (!reps.length) return;
      const s: UploadState = { total: reps.length, done: 0, imported: 0, duplicates: 0, errors: [] };
      setState({ ...s });
      for (const file of reps) {
        const form = new FormData();
        form.append("file", file);
        try {
          const res = await fetch("/api/upload", { method: "POST", body: form });
          const body = await res.json();
          if (body.status === "imported") s.imported++;
          else if (body.status === "duplicate") s.duplicates++;
          else s.errors.push(`${file.name}: ${body.detail ?? body.error ?? "error"}`);
        } catch {
          s.errors.push(`${file.name}: fallo de red`);
        }
        s.done++;
        setState({ ...s });
      }
      router.refresh();
    },
    [router]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        uploadFiles([...e.dataTransfer.files]);
      }}
      onClick={() => inputRef.current?.click()}
      className="card cursor-pointer p-4 text-center transition-colors"
      style={
        drag
          ? { borderColor: "var(--psi)", background: "var(--psi-dim)" }
          : undefined
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept=".rep"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) uploadFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
      {state ? (
        <div className="text-[12px]">
          {state.done < state.total ? (
            <p className="font-data text-[var(--psi)]">
              Analizando {state.done + 1}/{state.total}…
            </p>
          ) : (
            <p className="font-data">
              <span className="text-[var(--vespene)]">{state.imported} importados</span>
              {state.duplicates > 0 && (
                <span className="text-[var(--ink-faint)]"> · {state.duplicates} duplicados</span>
              )}
              {state.errors.length > 0 && (
                <span className="text-[var(--supply-red)]"> · {state.errors.length} errores</span>
              )}
            </p>
          )}
          {state.errors.map((e) => (
            <p key={e} className="mt-1 text-[11px] text-[var(--supply-red)]">{e}</p>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--ink-dim)]">
          Arrastra tus <span className="font-data text-[var(--ink)]">.rep</span> aquí o haz click
          para subirlos
        </p>
      )}
    </div>
  );
}
