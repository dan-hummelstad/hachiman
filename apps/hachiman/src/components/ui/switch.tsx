'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'

/**
 * Pill toggle: accent track when on, raised track when off. `size="touch"` is the mobile kit
 * toggle (46 × 28, knob 22) with a 44 high hit area, so a tap just above or below still toggles it.
 */
function Switch({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { size?: 'default' | 'touch' }) {
  const touch = size === 'touch'
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer rounded-pill data-[state=checked]:bg-accent-primary data-[state=unchecked]:bg-surface-raised data-[state=unchecked]:border-line-strong data-[state=checked]:border-transparent inline-flex h-5 w-9 shrink-0 items-center border p-0.5 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-line-focus disabled:cursor-not-allowed disabled:opacity-50',
        touch && 'relative h-7 w-[46px] after:absolute after:-inset-x-1 after:-inset-y-2',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'rounded-pill data-[state=unchecked]:bg-text-tertiary pointer-events-none block size-3.5 bg-white transition-transform duration-100 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
          touch && 'size-[22px] data-[state=checked]:translate-x-[18px]'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
