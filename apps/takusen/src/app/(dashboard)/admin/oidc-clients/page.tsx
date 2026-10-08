import { DashboardShell } from '@/components/dashboard-shell'
import { AdminOidcClientsView } from '@/components/admin/oidc-clients'
import { Tag } from '@/components/ui/badge'

export const metadata = {
  title: 'OIDC clients · Takusen',
}

export default function Page(): React.JSX.Element {
  return (
    <DashboardShell
      section="admin"
      crumbs={[{ label: 'OIDC clients' }]}
      title="OIDC clients"
      description="Applications that sign people in through Takusen."
      actions={<Tag tone="neutral">Read only</Tag>}
    >
      <AdminOidcClientsView />
    </DashboardShell>
  )
}
