import { DashboardShell } from '@/components/dashboard-shell'
import { SearchField } from '@/components/admin/kit'
import { AdminGuildsView } from '@/components/admin/guilds'
import { getAdminCounts } from '@/lib/admin-stats'

export const metadata = {
  title: 'Guilds · Takusen',
}

export default async function Page(): Promise<React.JSX.Element> {
  const counts = await getAdminCounts()
  return (
    <DashboardShell
      section="admin"
      crumbs={[{ label: 'Guilds' }]}
      title="Guilds"
      description="Every guild in this deployment. Deleting one removes it for all of its members."
      actions={<SearchField placeholder="Search guilds" />}
    >
      <AdminGuildsView total={counts.guilds} />
    </DashboardShell>
  )
}
