import { cn } from '@/lib/utils'

/** Group label (settings sections, popover groups): the `section-label` type style. */
export function SectionHeading({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <h2 className={cn('section-label mb-2', className)}>{children}</h2>
}

/** Label above a control, optional hint below. */
export function Field({
  id,
  label,
  hint,
  children,
  className
}: {
  id?: string
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <label htmlFor={id} className="section-label">
        {label}
      </label>
      {children}
      {hint && <p className="text-meta text-text-tertiary">{hint}</p>}
    </div>
  )
}

export function ErrorText({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element | null {
  if (!children) return null
  return (
    <p role="alert" className={cn('text-meta text-you-text', className)}>
      {children}
    </p>
  )
}
