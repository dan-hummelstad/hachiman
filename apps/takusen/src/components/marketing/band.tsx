import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** The landing page column: 1440 wide at most, 48px gutters (20 on a phone). */
export function Container({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return <div className={cn('mx-auto w-full max-w-[1440px] px-5 sm:px-12', className)}>{children}</div>
}

/** One square band of the landing page, divided from the one above by a hairline. */
export function Band({
  id,
  labelledBy,
  className,
  children,
}: {
  id?: string
  labelledBy: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section id={id} aria-labelledby={labelledBy} className="scroll-mt-4 border-t border-line-hairline">
      <Container className={cn('flex flex-col gap-5 py-9 sm:gap-11 sm:py-24', className)}>
        {children}
      </Container>
    </section>
  )
}

export function Kicker({
  tone = 'gold',
  children,
}: {
  tone?: 'gold' | 'voice'
  children: ReactNode
}): React.JSX.Element {
  return (
    <p
      className={cn(
        'text-[11.5px] leading-4 font-extrabold tracking-[1px] uppercase sm:text-[13px] sm:tracking-[1.2px]',
        tone === 'gold' ? 'text-gold-text' : 'text-feature-voice-text',
      )}
    >
      {children}
    </p>
  )
}

export function BandTitle({
  id,
  className,
  children,
}: {
  id: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <h2
      id={id}
      className={cn(
        'text-[30px] leading-[1.1] font-extrabold tracking-[-0.8px] text-text-primary sm:text-[46px] sm:leading-[1.08] sm:tracking-[-1.2px]',
        className,
      )}
    >
      {children}
    </h2>
  )
}

/** Copy that the phone layout shortens: `short` below `sm`, `long` from `sm` up. */
export function Fit({ short, long }: { short: ReactNode; long: ReactNode }): React.JSX.Element {
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="max-sm:hidden">{long}</span>
    </>
  )
}
