/**
 * Dashboard navigation (left column on desktop, strip on phones). To add a page, add an item
 * here; admin items also show up as rows on the /admin overview.
 */
export interface NavItem {
  href: string
  label: string
  /** One line for overview lists. */
  description?: string
  /** Match only the exact path (for section overviews like /admin). */
  exact?: boolean
}

export interface NavGroup {
  heading: string
  /** Shown only when session.user.role === 'admin'. */
  adminOnly?: boolean
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Your account',
    items: [
      { href: '/dashboard', label: 'Overview', exact: true },
      {
        href: '/account',
        label: 'Account',
        description: 'Change your display name or password.',
      },
    ],
  },
  {
    heading: 'Admin',
    adminOnly: true,
    items: [
      { href: '/admin', label: 'Overview', exact: true },
      {
        href: '/admin/users',
        label: 'Users',
        description: 'Search accounts, grant admin, sign people out, delete accounts.',
      },
      {
        href: '/admin/guilds',
        label: 'Guilds',
        description: 'Every guild, its owner and members. Delete abusive guilds.',
      },
      {
        href: '/admin/media-nodes',
        label: 'Media nodes',
        description: 'Registered SFU nodes, their load and last heartbeat. Drain or remove nodes.',
      },
      {
        href: '/admin/regions',
        label: 'Regions',
        description: 'Voice regions that guilds and media nodes use.',
      },
      {
        href: '/admin/oidc-clients',
        label: 'OIDC clients',
        description: 'Applications that sign users in through Takusen.',
      },
    ],
  },
]

export const ADMIN_GROUP = NAV_GROUPS.find((g) => g.adminOnly)!

export function navGroupsFor(role: 'user' | 'admin'): NavGroup[] {
  return NAV_GROUPS.filter((g) => !g.adminOnly || role === 'admin')
}

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}
