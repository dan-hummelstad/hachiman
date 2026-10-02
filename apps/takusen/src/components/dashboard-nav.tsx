'use client'

import { LogOutIcon } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { isActive, navGroupsFor, type NavItem } from '@/components/dashboard-nav-items'
import { TakusenLogo } from '@/components/takusen-logo'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { initialsFor } from '@/components/initials'
import { signOutToHome, UserIdentity, UserMenu } from '@/components/user-menu'
import { cn } from '@/lib/utils'

export interface DashboardNavProps {
  name: string
  email: string
  role: 'user' | 'admin'
}

const NAV_LINK = {
  // Settings-nav row (Hachiman `SelectableRow`): 32px, accent fill and amber notch when current.
  column: {
    base: 'h-8 w-full shrink-0 px-2.5',
    active:
      'bg-accent font-medium text-foreground before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary',
    idle: 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
  },
  // Phone tab strip: 40px, amber underline when current.
  strip: {
    base: 'h-10 px-3',
    active:
      'font-medium text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary',
    idle: 'text-muted-foreground hover:text-foreground',
  },
}

function NavLink({
  item,
  active,
  variant,
  label = item.label,
}: {
  item: NavItem
  active: boolean
  variant: keyof typeof NAV_LINK
  label?: string
}): React.JSX.Element {
  const v = NAV_LINK[variant]
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex items-center text-sm whitespace-nowrap -outline-offset-2',
        v.base,
        active ? v.active : v.idle,
      )}
    >
      {label}
    </Link>
  )
}

/**
 * Dashboard navigation, Discord-settings style (docs/ui-redesign.md §4 "Settings"):
 * a left column on --sidebar from md up; on phones a 48px title bar plus a scrolling strip.
 */
export function DashboardNav({ name, email, role }: DashboardNavProps): React.JSX.Element {
  const pathname = usePathname() ?? ''
  const groups = navGroupsFor(role)

  return (
    <>
      <header className="sticky top-0 z-40 border-b bg-sidebar md:hidden">
        <div className="flex h-12 items-center justify-between gap-2 pr-2 pl-3">
          <Link href="/dashboard" aria-label="Takusen dashboard">
            <TakusenLogo />
          </Link>
          <UserMenu name={name} email={email} />
        </div>
        <nav aria-label="Dashboard" className="flex overflow-x-auto border-t px-1">
          {groups.map((g, gi) => (
            <div
              key={g.heading}
              role="group"
              aria-label={g.heading}
              className={cn('flex shrink-0', gi > 0 && 'ml-1 border-l pl-1')}
            >
              {g.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  variant="strip"
                  active={isActive(item, pathname)}
                  // A later group's overview tab is named after the group ("Admin").
                  label={gi > 0 && item.exact ? g.heading : item.label}
                />
              ))}
            </div>
          ))}
        </nav>
      </header>

      {/* md and up: the settings nav column. The column grows left; the nav keeps 232px. */}
      <div className="hidden shrink-0 justify-end bg-sidebar md:flex md:flex-[1_0_232px]">
        <div className="sticky top-0 flex h-dvh w-[232px] flex-col px-2 pt-6 pb-2">
          <Link href="/dashboard" className="mb-6 self-start px-2.5" aria-label="Takusen dashboard">
            <TakusenLogo />
          </Link>
          <nav aria-label="Dashboard" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {groups.map((g) => (
              <div key={g.heading} className="mb-3 flex flex-col">
                <h2 className="section-label px-2.5 pb-1">{g.heading}</h2>
                {g.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    variant="column"
                    active={isActive(item, pathname)}
                  />
                ))}
              </div>
            ))}
            <div className="mt-1 border-t pt-3">
              <button
                type="button"
                onClick={signOutToHome}
                className="flex h-8 w-full items-center justify-between px-2.5 text-left text-sm font-medium text-destructive -outline-offset-2 hover:bg-accent [&_svg]:size-4"
              >
                Sign out
                <LogOutIcon aria-hidden />
              </button>
            </div>
          </nav>
          {/* User panel, as at the bottom of Hachiman's channel sidebar. */}
          <div className="mt-2 flex items-center gap-2 border-t px-1 pt-2">
            <Avatar>
              <AvatarFallback>{initialsFor(name, email)}</AvatarFallback>
            </Avatar>
            <UserIdentity name={name} email={email} />
          </div>
        </div>
      </div>
    </>
  )
}
