import { CommandBar } from "@/components/CommandBar";

export default function DojoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <CommandBar />
      <main className="mx-auto max-w-6xl px-5 pb-16 pt-7">{children}</main>
    </div>
  );
}
