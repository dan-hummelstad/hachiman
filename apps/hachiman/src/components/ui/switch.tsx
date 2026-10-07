'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'

/** Pill toggle: accent track when on, raised track when off. */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer rounded-pill data-[state=checked]:bg-accent-primary data-[state=unchecked]:bg-surface-raised data-[state=unchecked]:border-line-strong data-[state=checked]:border-transparent inline-flex h-5 w-9 shrink-0 items-center border p-0.5 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-line-focus disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="rounded-pill data-[state=unchecked]:bg-text-tertiary pointer-events-none block size-3.5 bg-white transition-transform duration-100 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
