import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { DashboardNav } from '@/components/dashboard-nav'
import { getOptionalUser } from '@/lib/auth-helpers'

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

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground md:flex-row">
      <DashboardNav
        name={user.name ?? ''}
        email={user.email ?? ''}
        role={user.role}
      />
      <main className="flex min-w-0 flex-[1_1_800px]">{children}</main>
    </div>
  )
}
