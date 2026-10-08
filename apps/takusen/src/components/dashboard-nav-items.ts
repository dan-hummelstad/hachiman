import {
  AppWindowIcon,
  CastleIcon,
  EarthIcon,
  GaugeIcon,
  HouseIcon,
  ServerIcon,
  ShieldIcon,
  UserRoundIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react'

import type { AdminCounts } from '@/lib/admin'

/**
 * Dashboard navigation (the sidebar, the ⌘K palette and the page bar crumbs). To add a page,
 * add an item here; admin items also show up as rows on the /admin overview.
 */
export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** One line for overview lists. */
  description?: string
  /** Match only the exact path (for section overviews like /admin). */
  exact?: boolean
  /** The admin count shown as the row's badge. */
  count?: keyof AdminCounts
}

export type NavSection = 'account' | 'admin'

export interface NavGroup {
  section: NavSection
  heading: string
  /** The page bar's first crumb and its icon. */
  crumb: { label: string; href: string; icon: LucideIcon }
  /** Shown only when session.user.role === 'admin'. */
  adminOnly?: boolean
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    section: 'account',
    heading: 'Your account',
    crumb: { label: 'Your account', href: '/dashboard', icon: UserRoundIcon },
    items: [
      { href: '/dashboard', label: 'Overview', icon: HouseIcon, exact: true },
      {
        href: '/account',
        label: 'Account',
        icon: UserRoundIcon,
        description: 'Change your display name or password.',
      },
    ],
  },
  {
    section: 'admin',
    heading: 'Admin',
    crumb: { label: 'Admin', href: '/admin', icon: ShieldIcon },
    adminOnly: true,
    items: [
      { href: '/admin', label: 'Overview', icon: GaugeIcon, exact: true },
      {
        href: '/admin/users',
        label: 'Users',
        icon: UsersRoundIcon,
        count: 'users',
        description: 'Search accounts, grant admin, sign people out, delete accounts.',
      },
      {
        href: '/admin/guilds',
        label: 'Guilds',
        icon: CastleIcon,
        count: 'guilds',
        description: 'Every guild, its owner and members. Delete abusive guilds.',
      },
      {
        href: '/admin/media-nodes',
        label: 'Media nodes',
        icon: ServerIcon,
        count: 'mediaNodes',
        description: 'Registered SFU nodes, their load and last heartbeat. Drain or remove nodes.',
      },
      {
        href: '/admin/regions',
        label: 'Regions',
        icon: EarthIcon,
        count: 'regions',
        description: 'Voice regions that guilds and media nodes use.',
      },
      {
        href: '/admin/oidc-clients',
        label: 'OIDC clients',
        icon: AppWindowIcon,
        count: 'oidcClients',
        description: 'Applications that sign users in through Takusen.',
      },
    ],
  },
]

export function navGroup(section: NavSection): NavGroup {
  return NAV_GROUPS.find((g) => g.section === section)!
}

export function navGroupsFor(role: 'user' | 'admin'): NavGroup[] {
  return NAV_GROUPS.filter((g) => !g.adminOnly || role === 'admin')
}

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}
