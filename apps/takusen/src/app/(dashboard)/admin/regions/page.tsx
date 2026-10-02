import { DashboardShell } from '@/components/dashboard-shell'
import { AdminRegionsView } from '@/components/admin/regions'

export const metadata = {
  title: 'Regions · Takusen',
}

export default function Page(): React.JSX.Element {
  return (
    <DashboardShell wide title="Regions" description="Voice regions that guilds can choose. Media nodes register into one of these.">
      <AdminRegionsView />
    </DashboardShell>
  )
}
