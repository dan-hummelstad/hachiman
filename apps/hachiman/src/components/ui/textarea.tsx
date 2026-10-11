import * as React from 'react'

import {
  FieldLead,
  LEAD_PADDING,
  TOUCH_FIELD,
  useFieldControl,
  type FieldSize
} from '@/components/ui/input'
import { cn } from '@/lib/utils'

function Textarea({
  className,
  size = 'default',
  lead,
  ...props
}: React.ComponentProps<'textarea'> & {
  /** `touch`: the mobile kit field (text 16, padding 12/14, no resize grip). */
  size?: FieldSize
  /** An icon beside the first line. With it, the textarea sits in a full-width wrapper. */
  lead?: React.ReactNode
}) {
  const touch = size === 'touch'
  const field = useFieldControl()
  const textarea = (
    <textarea
      {...field}
      data-slot="textarea"
      className={cn(
        'rounded-control border-line-strong bg-surface-sunken placeholder:text-text-tertiary selection:bg-accent-tint selection:text-text-primary hover:border-text-disabled focus-visible:border-accent-primary aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full border px-3 py-2 text-sm leading-5 transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50',
        touch && [TOUCH_FIELD, 'min-h-24 resize-none py-3'],
        lead != null && LEAD_PADDING[size],
        className
      )}
      {...props}
    />
  )
  if (lead == null) return textarea
  return (
    <span data-slot="textarea-wrapper" className="relative flex w-full min-w-0">
      <FieldLead
        size={size}
        className={touch ? 'top-[15.5px] translate-y-0' : 'top-2.5 translate-y-0'}
      >
        {lead}
      </FieldLead>
      {textarea}
    </span>
  )
}

export { Textarea }
