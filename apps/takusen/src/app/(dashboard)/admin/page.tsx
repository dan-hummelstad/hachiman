import { DashboardShell } from '@/components/dashboard-shell'
import { AdminOverviewView } from '@/components/admin/overview'

export const metadata = {
  title: 'Admin · Takusen',
}

export default function AdminPage(): React.JSX.Element {
  return (
    <DashboardShell
      section="admin"
      crumbs={[{ label: 'Overview' }]}
      title="Admin"
      description="Operators of this Takusen deployment. Everything here affects every Hachiman user."
    >
      <AdminOverviewView />
    </DashboardShell>
  )
}
