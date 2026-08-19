"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/games", label: "Partidas" },
  { href: "/chat", label: "Coach" },
];

export function CommandBar() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header
      className="sticky top-0 z-20 border-b backdrop-blur-md"
      style={{
        borderColor: "var(--grid-line)",
        background: "linear-gradient(180deg, rgba(10,32,24,0.85), rgba(6,16,13,0.6))",
      }}
    >
      <div className="mx-auto flex h-[52px] max-w-[1440px] items-center gap-5 px-4">
        <Link href="/" className="flex items-center gap-1.5">
          {/* Logo mark: twin phosphor blades. */}
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M2 18 L11 2 L14 2 L5 18 Z" fill="var(--psi)" />
            <path d="M12 18 L21 2 L24 2 L15 18 Z" fill="var(--gold)" opacity="0.9" />
          </svg>
          <span className="text-[15px] font-bold tracking-tight">DOJO</span>
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-[2px] border px-3 py-[5px] text-[12px] font-medium transition-colors"
                style={
                  active
                    ? {
                        color: "var(--psi)",
                        background: "var(--psi-dim)",
                        borderColor: "rgba(84,232,150,0.3)",
                      }
                    : { color: "var(--ink-dim)", borderColor: "transparent" }
                }
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="font-data hidden text-[11px] text-[var(--ink-faint)] sm:block">
            EdgarallanPulp
          </span>
          <button onClick={logout} className="btn px-3 py-1 text-[12px]">
            Salir
          </button>
        </div>
      </div>
    </header>
  );
}
