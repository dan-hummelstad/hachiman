'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { TakusenLogo } from '@/components/takusen-logo'
import { UserMenu } from '@/components/user-menu'
import { cn } from '@/lib/utils'

interface NavItem {
  href: string
  label: string
  match: (pathname: string) => boolean
}

const baseNav: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    match: (p) => p === '/dashboard',
  },
  {
    href: '/account',
    label: 'Account',
    match: (p) => p === '/account' || p.startsWith('/account/'),
  },
]

const adminNav: NavItem = {
  href: '/admin',
  label: 'Admin',
  match: (p) => p === '/admin' || p.startsWith('/admin/'),
}

export interface DashboardNavProps {
  name: string
  email: string
  role: 'user' | 'admin'
}

export function DashboardNav({
  name,
  email,
  role,
}: DashboardNavProps): React.JSX.Element {
  const pathname = usePathname() ?? ''
  const items = role === 'admin' ? [...baseNav, adminNav] : baseNav

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TakusenLogo className="text-base" />
        </Link>
        <nav
          aria-label="Primary"
          className="hidden flex-1 items-center gap-1 sm:flex"
        >
          {items.map((item) => {
            const active = item.match(pathname)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'bg-accent text-accent-foreground',
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <UserMenu name={name} email={email} />
        </div>
      </div>
      {/* Mobile nav (sm:hidden) — horizontal scroll */}
      <nav
        aria-label="Primary (mobile)"
        className="flex items-center gap-1 overflow-x-auto border-t border-border px-4 py-1 sm:hidden"
      >
        {items.map((item) => {
          const active = item.match(pathname)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                active && 'bg-accent text-accent-foreground',
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
    </header>
  )
}
