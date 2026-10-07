import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const PRIMARY =
  'bg-accent-primary text-text-on-accent hover:bg-accent-primary/90 active:bg-accent-primary/80'
const SECONDARY =
  'bg-surface-raised text-text-primary border-line-hairline hover:bg-surface-hover hover:border-line-strong'
const DANGER =
  'bg-feature-danger text-text-on-accent hover:bg-feature-danger/90 active:bg-feature-danger/80'
const QUIET = 'text-text-primary hover:bg-surface-hover'

/** Arc kit buttons (docs/ui-redesign.md §5): all radius 8. The shadcn names stay as aliases. */
const buttonVariants = cva(
  "rounded-control inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border border-transparent text-sm leading-5 font-semibold select-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-line-focus aria-invalid:border-feature-danger",
  {
    variants: {
      variant: {
        primary: PRIMARY,
        secondary: SECONDARY,
        danger: DANGER,
        /** Outlined danger: a destructive action that is not the main action. */
        'danger-outline':
          'border-feature-danger/60 text-feature-danger-text hover:bg-feature-danger/10',
        quiet: QUIET,
        voice:
          'bg-feature-voice text-[#06281a] hover:bg-feature-voice/90 active:bg-feature-voice/80',
        default: PRIMARY,
        destructive: DANGER,
        outline: SECONDARY,
        ghost: QUIET,
        link: 'h-auto! rounded-none border-0 px-0! text-accent-text underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-8 px-3 has-[>svg]:px-2.5',
        sm: 'h-7 gap-1 px-2.5 text-[13px] has-[>svg]:px-2',
        lg: 'h-9 px-4 has-[>svg]:px-3',
        icon: 'size-8',
        'icon-sm': 'size-7',
        'icon-lg': 'size-9'
      }
    },
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
