import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { DashboardFrame } from '@/components/dashboard-frame'
import { DashboardSidebar } from '@/components/dashboard-sidebar'
import { getAccountSummary } from '@/lib/account'
import { getAdminCounts } from '@/lib/admin-stats'
import { getOptionalUser } from '@/lib/auth-helpers'
import { desktopDownloadFor, hachimanLinks } from '@/lib/deployment'

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}): Promise<React.JSX.Element> {
  const session = await getOptionalUser()
  if (!session) {
    // Try to preserve the requested path so we can bounce the user back here
    // after a successful login. Next.js doesn't expose pathname directly in
    // layouts, but the `x-pathname` / `referer` headers are usable in
    // practice; fall back to /dashboard if neither is present.
    const hdrs = await headers()
    const referer = hdrs.get('referer')
    let next: string = '/dashboard'
    if (referer) {
      try {
        const url = new URL(referer)
        if (url.pathname.startsWith('/') && !url.pathname.startsWith('//')) {
          next = url.pathname + url.search
        }
      } catch {
        // ignore — fall back to default
      }
    }
    redirect(`/login?next=${encodeURIComponent(next)}`)
  }

  const { user } = session
  const admin = user.role === 'admin'
  const [summary, counts, hdrs] = await Promise.all([
    getAccountSummary(user.id),
    admin ? getAdminCounts() : null,
    headers(),
  ])
  const links = hachimanLinks()

  return (
    <DashboardFrame
      admin={admin}
      sidebar={
        <DashboardSidebar
          user={{
            name: summary?.displayName ?? user.name ?? '',
            email: summary?.email ?? user.email ?? '',
            role: user.role,
            avatarUrl: summary?.avatarUrl ?? null,
          }}
          counts={counts}
          hachiman={{ state: summary?.hachiman ?? 'never', guildCount: summary?.guildCount ?? 0 }}
          links={links}
          download={desktopDownloadFor(hdrs.get('user-agent'), links)}
        />
      }
    >
      {children}
    </DashboardFrame>
  )
}
