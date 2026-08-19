import { CommandBar } from "@/components/CommandBar";

export default function DojoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <CommandBar />
      <main className="mx-auto max-w-[1400px] px-4 pb-16 pt-5">{children}</main>
    </div>
  );
}
