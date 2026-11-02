import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * Touch has no hover (Tailwind puts `hover:` under `@media (hover: hover)`) and the mobile layout
 * turns off the tap flash, so the mobile layout shows a press fill instead.
 */
const PRESS = 'mobile:active:bg-surface-hover'

const PRIMARY = 'bg-ink text-on-ink hover:bg-ink/90 active:bg-ink/80'
const SECONDARY = cn(
  'bg-transparent border-line-strong text-text-primary hover:bg-surface-hover',
  PRESS
)
const DANGER = cn(
  'bg-transparent border-you text-you-text hover:bg-you-tint mobile:active:bg-you-tint'
)
const QUIET = cn('text-text-secondary hover:text-text-primary hover:bg-surface-hover', PRESS)

/**
 * Kit buttons: the primary is inverted ink, so no colour answer competes with a plain action.
 * Danger is an outline: an irreversible action answers `you`.
 */
const buttonVariants = cva(
  "rounded-control inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border border-transparent text-sm leading-5 font-semibold tracking-[-0.1px] select-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-line-focus aria-invalid:border-you",
  {
    variants: {
      variant: {
        primary: PRIMARY,
        secondary: SECONDARY,
        danger: DANGER,
        /** Outlined danger: a destructive action that is not the main action. */
        'danger-outline': DANGER,
        quiet: QUIET,
        voice:
          'bg-live text-on-live hover:bg-live/90 active:bg-live/80 font-mono font-[700] tracking-[0.8px] uppercase',
        link: 'h-auto! rounded-none border-0 px-0! text-here-text underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-9 px-4 has-[>svg]:px-3',
        sm: 'h-8 gap-1 px-3 text-[13px] has-[>svg]:px-2.5',
        lg: 'h-10 px-5 has-[>svg]:px-4',
        icon: 'size-8',
        'icon-sm': 'size-7',
        'icon-lg': 'size-9',
        /** Mobile kit button: 48 tall, full-width pill, label 15/600, icon 18. */
        mobile:
          "rounded-pill h-12 w-full gap-2 px-5 text-[15px] font-semibold [&_svg:not([class*='size-'])]:size-[18px]"
      }
    },
    compoundVariants: [
      // The mobile primary is the one pill in the accent; secondary is a raised chip, quiet an outline.
      { variant: 'primary', size: 'mobile', className: 'bg-here text-on-here hover:bg-here/90' },
      { variant: 'secondary', size: 'mobile', className: 'bg-surface-raised border-transparent' },
      {
        variant: 'quiet',
        size: 'mobile',
        className: 'border-[1.5px] border-line-strong text-text-primary'
      }
    ],
    defaultVariants: {
      variant: 'primary',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant = 'primary',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }): React.JSX.Element {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
