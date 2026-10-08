import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { DashboardFrame } from '@/components/dashboard-frame'
import { DashboardSidebar } from '@/components/dashboard-sidebar'
import { getAccountSummary } from '@/lib/account'
import { adminCounts } from '@/lib/admin-stats'
import { getOptionalUser } from '@/lib/auth-helpers'
import { desktopDownloadFor, hachimanLinks } from '@/lib/deployment'
import { safeNext } from '@/lib/safe-next'

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}): Promise<React.JSX.Element> {
  const session = await getOptionalUser()
  if (!session) {
    // Layouts get no pathname; the referer brings the visitor back here after sign-in.
    redirect(`/login?next=${encodeURIComponent(nextFromReferer((await headers()).get('referer')))}`)
  }

  const { user } = session
  const admin = user.role === 'admin'
  const [summary, counts, hdrs] = await Promise.all([
    getAccountSummary(user.id),
    admin ? adminCounts() : null,
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

function nextFromReferer(referer: string | null): string {
  if (!referer) return '/dashboard'
  try {
    const url = new URL(referer)
    return safeNext(url.pathname + url.search) ?? '/dashboard'
  } catch {
    return '/dashboard'
  }
}
