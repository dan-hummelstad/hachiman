import { useMemo } from 'react'
import { FieldControlContext } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Mobile / Field (x1Mbvl): a 13/700 label, the control, then a 12.5 helper or an error line.
 * Put an `Input`, `NativeSelect` or `Textarea` with `size="touch"` inside. The field gives the
 * control its `id`, `aria-describedby` (the helper or error line, id `<id>-hint`) and, with an
 * error, `aria-invalid`, so the box turns red and VoiceOver reads the error with the field. Props
 * on the control win. Codes and keys take `font-mono` on the control.
 */
export function MobileField({
  id,
  label,
  hint,
  error,
  children,
  className
}: {
  id: string
  label: React.ReactNode
  hint?: React.ReactNode
  /** Replaces the helper while set. */
  error?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const note = error || hint
  const invalid = Boolean(error)
  const described = Boolean(note)
  const control = useMemo(
    () => ({ id, describedBy: described ? `${id}-hint` : undefined, invalid }),
    [id, described, invalid]
  )
  return (
    <div data-slot="mobile-field" className={cn('grid gap-2', className)}>
      <label htmlFor={id} className="text-text-secondary text-[13px] leading-4 font-bold">
        {label}
      </label>
      <FieldControlContext.Provider value={control}>{children}</FieldControlContext.Provider>
      {note && (
        <p
          id={`${id}-hint`}
          role={error ? 'alert' : undefined}
          className={cn(
            'text-[12.5px] leading-[1.4] font-medium',
            error ? 'text-feature-danger-text' : 'text-text-tertiary'
          )}
        >
          {note}
        </p>
      )}
    </div>
  )
}
