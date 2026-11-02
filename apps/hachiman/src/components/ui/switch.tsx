'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'

/**
 * Pill toggle: ink track when on, outlined when off. `size="touch"` is the mobile kit
 * toggle (46 × 28, knob 20) with a 44 high hit area, so a tap just above or below still toggles it.
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
        'peer rounded-pill data-[state=checked]:bg-ink data-[state=unchecked]:bg-transparent data-[state=unchecked]:border-line-strong data-[state=checked]:border-transparent inline-flex h-[22px] w-[38px] shrink-0 items-center border p-[3px] transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-line-focus disabled:cursor-not-allowed disabled:opacity-50',
        touch && 'relative h-7 w-[46px] p-[3px] after:absolute after:-inset-x-1 after:-inset-y-2',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'rounded-pill data-[state=unchecked]:bg-text-disabled data-[state=checked]:bg-on-ink pointer-events-none block size-4 transition-transform duration-100 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
          touch && 'size-[20px] data-[state=checked]:translate-x-[18px]'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
