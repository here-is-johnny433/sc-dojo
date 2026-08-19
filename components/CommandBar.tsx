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
    <header className="sticky top-0 z-20 border-b border-[var(--grid-line)] bg-[color-mix(in_srgb,var(--void)_88%,transparent)] backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-7 px-5">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-data text-[10px] uppercase tracking-[0.3em] text-[var(--psi)]">
            SC
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Dojo</span>
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-md px-3 py-1.5 text-[13px] transition-colors"
                style={
                  active
                    ? { color: "var(--psi)", background: "var(--psi-dim)" }
                    : { color: "var(--ink-dim)" }
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
