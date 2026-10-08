import { DashboardShell } from '@/components/dashboard-shell'
import { AdminGuildsView } from '@/components/admin/guilds'

export const metadata = {
  title: 'Guilds · Takusen',
}

export default function Page(): React.JSX.Element {
  return (
    <DashboardShell section="admin" crumbs={[{ label: 'Guilds' }]} title="Guilds" description="Every guild in this deployment. Deleting one removes it for all of its members.">
      <AdminGuildsView />
    </DashboardShell>
  )
}
