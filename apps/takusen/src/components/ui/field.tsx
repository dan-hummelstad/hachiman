import { CircleAlertIcon } from 'lucide-react'
import Link from 'next/link'

import { cn } from '@/lib/utils'

/** Kicker above a group (nav category, settings section): the `section-label` type style. */
export function SectionHeading({
  children,
  className,
  as: Heading = 'h2',
}: {
  children: React.ReactNode
  className?: string
  as?: 'h2' | 'h3'
}): React.JSX.Element {
  return <Heading className={cn('section-label mb-2', className)}>{children}</Heading>
}

/**
 * TK / Field: label row (13.5/700) with an optional right-side link, the control, then a
 * help line (13, tertiary) or an error line (13, danger, alert icon) in its place.
 */
export function Field({
  id,
  label,
  hint,
  error,
  aside,
  children,
  className,
}: {
  id?: string
  label: React.ReactNode
  hint?: React.ReactNode
  /** Replaces the hint. Give the control `aria-invalid` and `aria-describedby={`${id}-error`}`. */
  error?: React.ReactNode
  /** Right side of the label row, e.g. `<FieldLink href="/forgot-password">`. */
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-label text-text-primary">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <p
          id={id ? `${id}-error` : undefined}
          className="flex items-start gap-1.5 text-[13px] leading-[1.4] font-semibold text-feature-danger-text"
        >
          <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : (
        hint && (
          <p
            id={id ? `${id}-hint` : undefined}
            className="text-[13px] leading-[1.4] text-text-tertiary"
          >
            {hint}
          </p>
        )
      )}
    </div>
  )
}

/** The gold link on a field's label row ("Forgot password?"). */
export function FieldLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="text-[13px] leading-5 font-bold text-gold-text underline-offset-4 hover:underline"
    >
      {children}
    </Link>
  )
}
