import { DashboardShell } from '@/components/dashboard-shell'
import { AdminMediaNodesView } from '@/components/admin/media-nodes'

export const metadata = {
  title: 'Media nodes · Takusen',
}

export default function Page(): React.JSX.Element {
  return (
    <DashboardShell section="admin" crumbs={[{ label: 'Media nodes' }]}>
      <AdminMediaNodesView />
    </DashboardShell>
  )
}
