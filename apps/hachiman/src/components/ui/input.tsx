import * as React from 'react'

import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input bg-card h-9 w-full min-w-0 border px-3 py-1 text-sm leading-5 transition-colors outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        // Text fields always match :focus-visible, so they get an amber border instead of an outline.
        'hover:border-muted-foreground/60 focus-visible:border-ring',
        'aria-invalid:border-destructive',
        className
      )}
      {...props}
    />
  )
}

export { Input }
