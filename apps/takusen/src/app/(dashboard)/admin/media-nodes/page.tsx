import { DashboardShell } from '@/components/dashboard-shell'
import { AdminMediaNodesView } from '@/components/admin/media-nodes'

export const metadata = {
  title: 'Media nodes · Takusen',
}

export default function Page(): React.JSX.Element {
  return (
    <DashboardShell wide title="Media nodes" description="Registered SFU nodes, their load and last heartbeat. Drain a node before you stop it.">
      <AdminMediaNodesView />
    </DashboardShell>
  )
}
