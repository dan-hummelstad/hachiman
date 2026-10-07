import * as React from 'react'

import { cn } from '@/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'rounded-control border-line-strong bg-surface-sunken placeholder:text-text-tertiary selection:bg-accent-tint selection:text-text-primary hover:border-text-disabled focus-visible:border-accent-primary aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full border px-3 py-2 text-sm leading-5 transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
