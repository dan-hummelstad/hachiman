import type { HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * Takusen wordmark: an amber square with a "T" (the Hachiman sign-in window uses the same
 * mark with an "H"), then the name in Plex Sans 600.
 */
export function TakusenLogo({
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex items-center gap-2 text-[15px] leading-5 font-semibold text-foreground',
        className,
      )}
    >
      <TakusenMark />
      Takusen
    </span>
  )
}

/** The square "T" mark alone. Decorative. */
export function TakusenMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-6 shrink-0 items-center justify-center bg-primary text-[13px] leading-none font-semibold text-primary-foreground',
        className,
      )}
    >
      T
    </span>
  )
}
