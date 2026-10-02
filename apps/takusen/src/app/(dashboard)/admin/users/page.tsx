import { DashboardShell } from '@/components/dashboard-shell'
import { AdminUsersView } from '@/components/admin/users'
import { requireAdmin } from '@/lib/auth-helpers'

export const metadata = {
  title: 'Users · Takusen',
}

export default async function Page(): Promise<React.JSX.Element> {
  const session = await requireAdmin()
  return (
    <DashboardShell
      wide
      title="Users"
      description="Every account in this deployment. Grant admin, sign people out, or delete accounts."
    >
      <AdminUsersView meId={session.user.id} />
    </DashboardShell>
  )
}
