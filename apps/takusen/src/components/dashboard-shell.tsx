import { ChevronRightIcon } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { SidebarToggle } from '@/components/dashboard-frame'
import { navGroup, type NavSection } from '@/components/dashboard-nav-items'
import { Tag } from '@/components/ui/badge'
import { deploymentInfo } from '@/lib/deployment'
import { cn } from '@/lib/utils'

export interface Crumb {
  label: string
  /** Omit on the current page (the last crumb). */
  href?: string
}

export interface DashboardShellProps {
  /** The sidebar group: sets the first crumb ("Your account" / "Admin") and, for admin, the deployment tag. */
  section: NavSection
  /** Crumbs after the section crumb; the last one is the current page. */
  crumbs: Crumb[]
  title?: ReactNode
  description?: ReactNode
  /** Right of the title, bottom-aligned (e.g. the Users search field). */
  actions?: ReactNode
  /** Right side of the page bar, before the deployment tag. */
  barActions?: ReactNode
  children: ReactNode
}

/**
 * The page inside the dashboard content card (E1, F1): the page bar with crumbs, then the
 * scrolling page body with its head. A server component: render it from page.tsx.
 */
export function DashboardShell({
  section,
  crumbs,
  title,
  description,
  actions,
  barActions,
  children,
}: DashboardShellProps): React.JSX.Element {
  const group = navGroup(section)
  const RootIcon = group.crumb.icon
  const deployment = section === 'admin' ? deploymentInfo() : null
  const trail: Crumb[] = [{ label: group.crumb.label, href: group.crumb.href }, ...crumbs]

  return (
    <>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line-hairline pr-3.5 pl-4 md:pl-6">
        <SidebarToggle />
        <RootIcon aria-hidden className="size-[15px] shrink-0 text-text-tertiary" />
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-2 text-[13.5px] leading-5">
            {trail.map((c, i) => {
              const current = i === trail.length - 1
              return (
                <li
                  key={`${i}:${c.label}`}
                  className={cn('flex min-w-0 items-center gap-2', !current && 'shrink-0 max-sm:hidden')}
                >
                  {i > 0 && (
                    <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-text-disabled max-sm:hidden" />
                  )}
                  {current || !c.href ? (
                    <span
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'truncate',
                        current ? 'font-extrabold text-text-primary' : 'font-semibold text-text-tertiary',
                      )}
                    >
                      {c.label}
                    </span>
                  ) : (
                    <Link
                      href={c.href}
                      className="rounded-check font-semibold text-text-tertiary hover:text-text-primary"
                    >
                      {c.label}
                    </Link>
                  )}
                </li>
              )
            })}
          </ol>
        </nav>
        {barActions}
        {deployment && (
          <div className="flex shrink-0 items-center gap-2">
            {deployment.tag && <Tag tone="warning">{deployment.tag}</Tag>}
            <span className="font-mono text-xs text-text-tertiary max-sm:hidden">{deployment.name}</span>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full max-w-[1320px] flex-col gap-7 px-4 pt-6 pb-16 md:px-10 md:pt-8">
          {title && <PageHead title={title} description={description} actions={actions} />}
          {children}
        </div>
      </div>
    </>
  )
}

/**
 * The page head: title, description, actions bottom-right. DashboardShell renders it from its
 * props; a client view renders it itself when its head actions share state with the list
 * (filter chips with counts, the Add dialog), and the page then passes DashboardShell no title.
 */
export function PageHead({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h1 className="text-page-title text-text-primary">{title}</h1>
        {description && <p className="text-body text-text-tertiary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
