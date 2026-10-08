import { DashboardShell } from '@/components/dashboard-shell'
import { AdminOidcClientsView } from '@/components/admin/oidc-clients'

export const metadata = {
  title: 'OIDC clients · Takusen',
}

export default function Page(): React.JSX.Element {
  return (
    <DashboardShell section="admin" crumbs={[{ label: 'OIDC clients' }]}>
      <AdminOidcClientsView />
    </DashboardShell>
  )
}
