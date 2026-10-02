import { cn } from '@/lib/utils'

/** Group label (settings sections): the `section-label` type style. Same as Hachiman's. */
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

/** Label above a control, optional hint below. Same as Hachiman's `Field`. */
export function Field({
  id,
  label,
  hint,
  aside,
  children,
  className,
}: {
  id?: string
  label: string
  hint?: React.ReactNode
  /** Right side of the label row (e.g. a "Forgot password?" link). */
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs leading-4 font-semibold tracking-[0.01em]">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {hint && <p className="text-xs leading-4 text-muted-foreground">{hint}</p>}
    </div>
  )
}
