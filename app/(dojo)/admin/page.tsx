import { listUsers } from "@/lib/admin";
import { requireAdmin } from "@/lib/session";
import { AdminUsers } from "@/components/AdminUsers";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireAdmin();
  const users = await listUsers();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Jugadores</h1>
        <p className="text-[12px] text-[var(--ink-faint)]">
          Crea cuentas y vincula sus cuentas de Battle.net. Las partidas ya importadas se
          revinculan al añadir un alias.
        </p>
      </div>
      <AdminUsers initialUsers={users} sessionId={admin.id} />
    </div>
  );
}
