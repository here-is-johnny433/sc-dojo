"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/games", label: "Partidas" },
  { href: "/players", label: "Jugadores" },
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
        <Link href="/" className="flex items-center gap-2">
          {/* Logo mark: the SC monogram (official vector, cropped to content). */}
          <svg width="30" height="15" viewBox="1 13 45.5 22.5" aria-hidden fill="var(--ink)">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M5.4 17.77h12.2l1.6 1.4h.4l4.4-4.8v-.2l-.2-.2h-16q-1.2 0-1.8.6c-.6.4-1 1-1 2.2v.6c0 .2.2.4.4.4m40.4-3.6H28.2l-3.2 3v.4h14.2l.8 1.2s.2.2.4 0l5.6-4c0-.2 0-.2-.2-.6M40 32.77c-.4 0-1 .2-1.4.2-4.2-.2-7.4-3.4-7.8-7.4v-1.6c0-1.4 0-2.8.4-4.2v-.2h-6.4s-.2 0-.2.2c-.6 1.6-.8 3.2-.8 5 0 1.4.2 2 .6 3.6 1.2 3.8 5.6 7.2 9.2 7.2 5.4 0 6.8-1.8 6.8-2.4-.2-.2-.2-.4-.4-.4M13.8 19.768H6.6c-.2 0-.2.2-.2.2v.2s9.4 11 9.6 11.2h-5.4c-.8 0-1.6-.2-2.2-.8-.2-.2-.4-.4-.6-.8h-.4l-5.4 5v.4h19.8c1.2 0 1.8-1.2 2-2.4 0-.4-.2-1-.4-1.2-.8-1-9.6-11.8-9.6-11.8"
            />
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
