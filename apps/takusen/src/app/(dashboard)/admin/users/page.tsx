import { DashboardShell } from '@/components/dashboard-shell'
import { SearchField } from '@/components/admin/kit'
import { AdminUsersView } from '@/components/admin/users'
import { getAdminCounts } from '@/lib/admin-stats'
import { requireAdmin } from '@/lib/auth-helpers'

export const metadata = {
  title: 'Users · Takusen',
}

export default async function Page(): Promise<React.JSX.Element> {
  const [session, counts] = await Promise.all([requireAdmin(), getAdminCounts()])
  return (
    <DashboardShell
      section="admin"
      crumbs={[{ label: 'Users' }]}
      title="Users"
      description="Every account in this deployment. Grant admin, sign people out, or reset their keys."
      actions={<SearchField placeholder="Search by name or email" />}
    >
      <AdminUsersView meId={session.user.id} counts={counts} />
    </DashboardShell>
  )
}
