import { DashboardShell } from '@/components/dashboard-shell'
import { AdminOidcClientsView } from '@/components/admin/oidc-clients'

export const metadata = {
  title: 'OIDC clients · Takusen',
}

export default function Page(): React.JSX.Element {
  return (
    <DashboardShell wide title="OIDC clients" description="Applications that sign users in through Takusen. Read only; db:seed manages them.">
      <AdminOidcClientsView />
    </DashboardShell>
  )
}
