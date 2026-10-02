import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Content column for pages inside `(dashboard)/layout.tsx`: page title (20/28, 600), an
 * optional one-line description and actions, then the page body. 720px wide like the
 * Hachiman settings overlay; `wide` gives tables (admin pages) more room.
 */
export interface DashboardShellProps {
  title?: string
  description?: ReactNode
  actions?: ReactNode
  wide?: boolean
  children: ReactNode
}

export function DashboardShell({
  title,
  description,
  actions,
  wide,
  children,
}: DashboardShellProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col gap-6 px-4 pt-6 pb-20 md:px-10 md:pt-12',
        wide ? 'max-w-[1080px]' : 'max-w-[720px]',
      )}
    >
      {(title || actions) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            {title && <h1 className="text-xl leading-7 font-semibold">{title}</h1>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="flex flex-col gap-8">{children}</div>
    </div>
  )
}

/** A titled block inside a dashboard page, separated from the previous one by a 1px rule. */
export function DashboardSection({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn('flex flex-col gap-4 border-t pt-6 first:border-t-0 first:pt-0', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] leading-5 font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}
