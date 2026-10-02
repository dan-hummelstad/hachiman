import { ADMIN_GROUP } from '@/components/dashboard-nav-items'
import { DashboardShell } from '@/components/dashboard-shell'
import { AdminOverviewView } from '@/components/admin/overview'
import { DashboardSection } from '@/components/dashboard-shell'
import { LinkRows } from '@/components/link-rows'

export const metadata = {
  title: 'Admin · Takusen',
}

// The admin section's sub-pages come from the nav config, so a new page shows up here
// (and in the nav) once it is added to ADMIN_GROUP in components/dashboard-nav-items.ts.
const SECTIONS = ADMIN_GROUP.items.filter((i) => !i.exact)

export default function AdminPage(): React.JSX.Element {
  return (
    <DashboardShell wide title="Admin" description="Tools for operators of this Takusen instance.">
      <AdminOverviewView />
      <DashboardSection title="Manage">
        <LinkRows items={SECTIONS} />
      </DashboardSection>
    </DashboardShell>
  )
}
