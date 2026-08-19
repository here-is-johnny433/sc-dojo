import { CommandBar } from "@/components/CommandBar";
import { requireUser } from "@/lib/session";

export default async function DojoLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-screen">
      <CommandBar user={{ name: user.name, role: user.role }} />
      <main className="mx-auto max-w-[1400px] px-4 pb-16 pt-5">{children}</main>
    </div>
  );
}
