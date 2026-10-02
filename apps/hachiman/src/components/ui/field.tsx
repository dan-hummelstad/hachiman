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
      <label htmlFor={id} className="text-xs leading-4 font-semibold tracking-[0.01em]">
        {label}
      </label>
      {children}
      {hint && <p className="text-muted-foreground text-xs leading-4">{hint}</p>}
    </div>
  )
}

export function ErrorText({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  if (!children) return null
  return (
    <p role="alert" className="text-destructive text-xs leading-4">
      {children}
    </p>
  )
}
