'use client'

import {
  ArrowUpRightIcon,
  DownloadIcon,
  GlobeIcon,
  LogOutIcon,
  PanelLeftIcon,
  SearchIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { useSyncExternalStore } from 'react'

import { useHideSidebar, useOpenPalette } from '@/components/dashboard-frame'
import { isActive, navGroupsFor, type NavItem } from '@/components/dashboard-nav-items'
import { initialsFor } from '@/components/initials'
import { Brand, HachimanMark } from '@/components/takusen-logo'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { HachimanState } from '@/lib/account'
import type { AdminCounts } from '@/lib/admin'
import type { HachimanLinks } from '@/lib/deployment'
import { cn } from '@/lib/utils'

export interface DashboardSidebarProps {
  user: { name: string; email: string; role: 'user' | 'admin'; avatarUrl: string | null }
  /** Admins only: the nav badges. */
  counts: AdminCounts | null
  hachiman: { state: HachimanState; guildCount: number }
  links: HachimanLinks
}

/** T3 / Sidebar (kit `b2aux0`): brand, jump-to, the nav groups, the Hachiman launcher, the user row. */
export function DashboardSidebar({
  user,
  counts,
  hachiman,
  links,
}: DashboardSidebarProps): React.JSX.Element {
  const pathname = usePathname() ?? ''
  const hideSidebar = useHideSidebar()
  const openPalette = useOpenPalette()

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-0.5 px-3 pt-4 pb-3">
      <div className="flex h-9 shrink-0 items-center pr-1 pl-1.5">
        <Link href="/dashboard" aria-label="Takusen dashboard" className="rounded-control">
          <Brand />
        </Link>
        <Button
          variant="quiet"
          size="icon"
          aria-label="Hide sidebar"
          onClick={hideSidebar}
          className="ml-auto"
        >
          <PanelLeftIcon />
        </Button>
      </div>

      <div className="shrink-0 pt-3 pb-2">
        <button
          type="button"
          onClick={openPalette}
          className="flex h-9 w-full items-center gap-2 rounded-control border border-line-hairline bg-surface-hover pr-2 pl-[11px] text-left text-[13.5px] font-medium text-text-tertiary transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-ring"
        >
          <SearchIcon aria-hidden className="size-[15px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {user.role === 'admin' ? 'Jump to user, guild, node…' : 'Jump to…'}
          </span>
          <kbd className="flex h-5 shrink-0 items-center rounded-[5px] border border-line-strong bg-surface-raised px-1.5 font-sans text-[11px] font-extrabold">
            ⌘K
          </kbd>
        </button>
      </div>

      <nav aria-label="Dashboard" className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
        {navGroupsFor(user.role).map((g) => (
          <div key={g.heading} role="group" aria-labelledby={`nav-${g.section}`} className="flex flex-col gap-0.5">
            <h2 id={`nav-${g.section}`} className="section-label flex h-[30px] items-end px-2.5 pb-0.5">
              {g.heading}
            </h2>
            {g.items.map((item) => (
              <NavRow
                key={item.href}
                item={item}
                active={isActive(item, pathname)}
                count={item.count && counts ? counts[item.count] : undefined}
              />
            ))}
          </div>
        ))}
      </nav>

      <HachimanLauncher {...hachiman} links={links} />

      <div className="flex shrink-0 items-center gap-2.5 px-1 pt-2.5">
        <Avatar className="size-[34px] rounded-full">
          {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
          <AvatarFallback className="rounded-full">{initialsFor(user.name, user.email)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-sm leading-[18px] font-extrabold">{user.name || user.email}</span>
          <span className="truncate text-[12.5px] leading-4 text-text-tertiary">{user.email}</span>
        </div>
        <Button
          variant="quiet"
          size="icon"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => void signOut({ callbackUrl: '/' })}
          className="[&_svg]:text-feature-danger-text"
        >
          <LogOutIcon />
        </Button>
      </div>
    </div>
  )
}

/** T3 / Nav row (kit `IBuoL`): 34px, rounded; the current page is a gold tint with a gold icon. */
function NavRow({
  item,
  active,
  count,
}: {
  item: NavItem
  active: boolean
  count?: number
}): React.JSX.Element {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-[34px] shrink-0 items-center gap-2.5 rounded-control px-2.5 text-[14.5px] transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        active
          ? 'bg-gold-tint font-bold text-text-primary'
          : 'font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      <Icon
        aria-hidden
        className={cn('size-[17px] shrink-0', active ? 'text-gold-text' : 'text-text-tertiary')}
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {count !== undefined && <Badge>{count}</Badge>}
    </Link>
  )
}

const LAUNCHER_STATUS: Record<HachimanState, { dot: string; label: (guilds: number) => string }> = {
  signed_in: {
    dot: 'bg-status-online',
    label: (n) => `Signed in · ${n} ${n === 1 ? 'guild' : 'guilds'}`,
  },
  signed_out: { dot: 'bg-status-offline', label: () => 'Signed out' },
  never: { dot: 'bg-status-offline', label: () => 'Not opened yet' },
}

/** The way back to your guilds: Hachiman's state, then open it (or get it, on a first visit). */
function HachimanLauncher({
  state,
  guildCount,
  links,
}: DashboardSidebarProps['hachiman'] & { links: HachimanLinks }): React.JSX.Element {
  const status = LAUNCHER_STATUS[state]
  const download = useDownloadLink(links)
  return (
    <section
      aria-label="Hachiman"
      className="mt-2 flex shrink-0 flex-col gap-3 border border-line-hairline bg-surface-raised p-3"
    >
      <div className="flex items-center gap-2.5">
        <HachimanMark size={34} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[14.5px] leading-[18px] font-extrabold">Hachiman</span>
          <span className="flex items-center gap-1.5 text-[12.5px] leading-4 font-semibold text-text-tertiary">
            <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full', status.dot)} />
            {status.label(guildCount)}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        {state === 'never' ? (
          <Button asChild variant="secondary" size="sm" className="flex-1">
            <a href={download}>
              <DownloadIcon />
              Get the app
            </a>
          </Button>
        ) : (
          <Button asChild variant="secondary" size="sm" className="flex-1">
            <a href={links.app}>
              <ArrowUpRightIcon />
              Open app
            </a>
          </Button>
        )}
        <Button asChild variant="quiet" size="sm">
          <a href={links.web} target="_blank" rel="noreferrer">
            <GlobeIcon />
            Web
          </a>
        </Button>
      </div>
    </section>
  )
}

const noSubscribe = (): (() => void) => () => {}

/** The desktop build for this OS; macOS on the server render. */
function useDownloadLink(links: HachimanLinks): string {
  const windows = useSyncExternalStore(
    noSubscribe,
    () => /windows/i.test(navigator.userAgent),
    () => false,
  )
  return windows ? links.download.windows : links.download.macos
}
