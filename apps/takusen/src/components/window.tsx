import Link from 'next/link'
import { useId, type ReactNode } from 'react'

import { TakusenLogo } from '@/components/takusen-logo'
import { cn } from '@/lib/utils'

export interface WindowProps {
  /** Text in the 40px title bar. Also the accessible name of the window. */
  title: ReactNode
  children: ReactNode
  /** Bottom strip on --sidebar (secondary links or right-aligned actions). */
  footer?: ReactNode
  /** Heading level of the title. Pages whose window is the main content use h1 (default). */
  as?: 'h1' | 'h2'
  className?: string
  bodyClassName?: string
}

/**
 * Old-messenger window (docs/ui-redesign.md §1): a title bar with an amber square, a body,
 * an optional footer strip and the hard offset shadow. Same look as the Hachiman sign-in window.
 */
export function Window({
  title,
  children,
  footer,
  as: Heading = 'h1',
  className,
  bodyClassName,
}: WindowProps): React.JSX.Element {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className={cn('w-full border bg-background text-foreground shadow-lg', className)}
    >
      <header className="flex h-10 items-center gap-2 border-b bg-sidebar px-3">
        <span aria-hidden className="size-3 shrink-0 bg-primary" />
        <Heading id={titleId} className="truncate text-sm leading-5 font-semibold">
          {title}
        </Heading>
      </header>
      <div className={cn('grid gap-4 p-5', bodyClassName)}>{children}</div>
      {footer && (
        <footer className="border-t bg-sidebar px-5 py-3 text-sm">{footer}</footer>
      )}
    </section>
  )
}

/** A full-height screen that centres one window on the app background, logo above it. */
export function WindowScreen({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <Link href="/" aria-label="Takusen home">
        <TakusenLogo />
      </Link>
      <main className={cn('w-full max-w-[380px]', className)}>{children}</main>
    </div>
  )
}
