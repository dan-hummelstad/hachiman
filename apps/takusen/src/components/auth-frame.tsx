import { LifeBuoyIcon, LockIcon } from 'lucide-react'
import Link from 'next/link'
import { Fragment, useId, type ReactNode } from 'react'

import { Brand } from '@/components/takusen-logo'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Links in the trust footer and the top bar. Takusen has no help, privacy, terms or status
 * pages yet, so they point at landing-page anchors; change them here when the pages exist.
 */
export const TRUST_LINKS = [
  { label: 'Help', href: '/#help' },
  { label: 'Privacy', href: '/#privacy' },
  { label: 'Terms', href: '/#terms' },
  { label: 'Status', href: '/#status' },
] as const

/**
 * The SSO page frame (B1–D2, H2–H4): the Takusen wallpaper (wash fading into the window
 * colour, a gold glow at the top), a top bar with the Brand and Help, then a centred column
 * for an optional `<HandoffRail>`, one `<AuthCard>` and the trust footer. Below `sm` the
 * column starts under the top bar instead of being centred.
 */
export function AuthScreen({
  rail,
  children,
  className,
}: {
  rail?: ReactNode
  children: ReactNode
  /** Classes for the content column (width). Default fits a 440px card. */
  className?: string
}): React.JSX.Element {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-[linear-gradient(180deg,var(--wash)_0%,var(--surface-window)_60%)]">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[300px] left-1/2 -z-10 size-[700px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,var(--glow),var(--glow-0))]"
      />
      <header className="flex h-[52px] shrink-0 items-center gap-2 px-4 sm:h-[72px] sm:px-7">
        <Link href="/" aria-label="Takusen home" className="rounded-control">
          <Brand />
        </Link>
        <Button asChild variant="quiet" className="ml-auto max-sm:size-8 max-sm:px-0">
          <Link href={TRUST_LINKS[0].href}>
            <LifeBuoyIcon aria-hidden className="size-[15px] max-sm:size-4" />
            <span className="max-sm:sr-only">Help</span>
          </Link>
        </Button>
      </header>
      <main
        className={cn(
          'mx-auto flex w-full max-w-[472px] flex-1 flex-col items-center gap-4 px-4 pt-3 pb-6 sm:justify-center sm:gap-[22px] sm:pt-6 sm:pb-[96px]',
          className,
        )}
      >
        {rail}
        {children}
        <TrustFooter />
      </main>
    </div>
  )
}

/** "Takusen never sees your Hachiman messages." and the Help · Privacy · Terms · Status row. */
export function TrustFooter(): React.JSX.Element {
  return (
    <footer className="flex flex-col items-center gap-3.5 pt-1 text-[13px] leading-4 font-semibold text-text-tertiary">
      <p className="flex items-center gap-2 text-center">
        <LockIcon aria-hidden className="size-3.5 shrink-0 text-feature-voice-text" />
        Takusen never sees your Hachiman messages.
      </p>
      <nav aria-label="Takusen" className="flex items-center gap-3.5">
        {TRUST_LINKS.map((l, i) => (
          <Fragment key={l.label}>
            {i > 0 && <span aria-hidden className="size-[3px] rounded-full bg-text-disabled" />}
            <Link href={l.href} className="hover:text-text-primary">
              {l.label}
            </Link>
          </Fragment>
        ))}
      </nav>
    </footer>
  )
}

/**
 * The square card on an SSO page: title (card-title type), optional lead, the body, and an
 * optional footer band ("New to Takusen? Create an account"). Use `<AuthFooterLink>` there.
 */
export function AuthCard({
  title,
  lead,
  children,
  footer,
  as: Heading = 'h1',
  className,
  bodyClassName,
}: {
  title: ReactNode
  lead?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  as?: 'h1' | 'h2'
  className?: string
  bodyClassName?: string
}): React.JSX.Element {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'w-full border border-line-hairline bg-surface-card text-text-primary shadow-card',
        className,
      )}
    >
      <div
        className={cn(
          'flex flex-col gap-[18px] px-5 py-6 sm:gap-[22px] sm:px-9 sm:pt-8 sm:pb-[30px]',
          bodyClassName,
        )}
      >
        <div className="flex flex-col gap-2">
          <Heading id={titleId} className="text-card-title">
            {title}
          </Heading>
          {lead && <p className="text-body text-text-secondary">{lead}</p>}
        </div>
        {children}
      </div>
      {footer && (
        <div className="flex flex-wrap items-center gap-x-1.5 border-t border-line-hairline bg-surface-panel px-5 py-3.5 text-sm sm:px-9 sm:py-4">
          {footer}
        </div>
      )}
    </section>
  )
}

/** "Question? Link" for an AuthCard footer band: secondary prompt, gold 800 link. */
export function AuthFooterLink({
  prompt,
  href,
  children,
}: {
  prompt: ReactNode
  href: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <p className="text-text-secondary">
      {prompt}{' '}
      <Link
        href={href}
        className="font-extrabold text-gold-text underline-offset-4 hover:underline"
      >
        {children}
      </Link>
    </p>
  )
}
