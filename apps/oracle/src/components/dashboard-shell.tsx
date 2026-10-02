import type { ReactNode } from 'react'

/**
 * Generic content wrapper for pages that live inside `(dashboard)/layout.tsx`.
 *
 * The dashboard layout already renders the top nav and a `<main>` element; this
 * shell just provides consistent padding + a max-width container so individual
 * pages (Account, Admin, etc.) look uniform without each having to repeat
 * the same layout boilerplate.
 *
 * Usage from another specialist's page:
 *   <DashboardShell title="Account" description="...">{...}</DashboardShell>
 */
export interface DashboardShellProps {
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}

export function DashboardShell({
  title,
  description,
  actions,
  children,
}: DashboardShellProps): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {(title || actions) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            {title && (
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {title}
              </h1>
            )}
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  )
}
