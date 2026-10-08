import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// T3 kit buttons: radius/control, Figtree 800, 15px icon. Gold is the Takusen action; the
// violet `hachiman` variant hands off to Hachiman and never sits next to a password field.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-[7px] whitespace-nowrap rounded-control border border-transparent text-sm leading-5 font-extrabold select-none transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-[15px] [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-feature-danger",
  {
    variants: {
      variant: {
        primary: "bg-gold text-on-gold hover:bg-gold-strong",
        secondary:
          "border-line-strong bg-surface-hover text-text-primary hover:bg-surface-raised [&_svg]:text-text-secondary",
        quiet:
          "text-text-secondary hover:bg-surface-hover hover:text-text-primary [&_svg]:text-text-tertiary",
        danger: "bg-feature-danger text-white hover:bg-feature-danger/85",
        "danger-soft":
          "border-feature-danger/25 bg-feature-danger/10 text-feature-danger-text hover:bg-feature-danger/15",
        hachiman: "bg-accent-primary text-white hover:bg-accent-primary/85",
        link: "h-auto! rounded-none border-0 px-0! font-bold text-gold-text underline-offset-4 hover:underline",
        // Older names, kept until every page moves to the kit names above.
        default: "bg-gold text-on-gold hover:bg-gold-strong",
        destructive: "bg-feature-danger text-white hover:bg-feature-danger/85",
        outline:
          "border-line-strong bg-surface-hover text-text-primary hover:bg-surface-raised [&_svg]:text-text-secondary",
        ghost:
          "text-text-secondary hover:bg-surface-hover hover:text-text-primary [&_svg]:text-text-tertiary",
      },
      size: {
        default: "h-9 px-3.5",
        xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 px-3 text-[13px]",
        lg: "h-11 px-4 text-[14.5px]",
        xl: "h-12 px-5 text-[15px]",
        icon: "size-8 [&_svg:not([class*='size-'])]:size-4",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-9 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    compoundVariants: [
      // Kit icon button: hairline square-ish tile, not the strong secondary border.
      {
        variant: "secondary",
        size: ["icon", "icon-xs", "icon-sm", "icon-lg"],
        className: "border-line-hairline",
      },
    ],
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

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
