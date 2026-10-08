import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { DashboardFrame } from '@/components/dashboard-frame'
import { DashboardSidebar } from '@/components/dashboard-sidebar'
import { getViewer } from '@/lib/account'
import { adminCounts } from '@/lib/admin-stats'
import { desktopDownloadFor, hachimanLinks } from '@/lib/deployment'
import { safeNext } from '@/lib/safe-next'

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}): Promise<React.JSX.Element> {
  const viewer = await getViewer()
  if (!viewer) {
    // Layouts get no pathname; the referer brings the visitor back here after sign-in.
    redirect(`/login?next=${encodeURIComponent(nextFromReferer((await headers()).get('referer')))}`)
  }

  const admin = viewer.role === 'admin'
  const [counts, hdrs] = await Promise.all([admin ? adminCounts() : null, headers()])
  const links = hachimanLinks()

  return (
    <DashboardFrame
      admin={admin}
      sidebar={
        <DashboardSidebar
          user={{
            name: viewer.displayName,
            email: viewer.email,
            role: viewer.role,
            avatarUrl: viewer.avatarUrl,
          }}
          counts={counts}
          hachiman={{ state: viewer.hachiman, guildCount: viewer.guildCount }}
          links={links}
          download={desktopDownloadFor(hdrs.get('user-agent'), links)}
        />
      }
    >
      {children}
    </DashboardFrame>
  )
}

function nextFromReferer(referer: string | null): string {
  if (!referer) return '/dashboard'
  try {
    const url = new URL(referer)
    return safeNext(url.pathname + url.search) ?? '/dashboard'
  } catch {
    return '/dashboard'
  }
}
