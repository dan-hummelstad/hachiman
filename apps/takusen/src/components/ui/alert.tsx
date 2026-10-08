import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Kit banner: square, raised fill, 3px left edge in the status colour, icon in the status
// text colour, title 14/800 and body 13.5 secondary (text + edge, never colour alone).
const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-[3px] border-l-[3px] bg-surface-raised px-4 py-3.5 text-[13.5px] leading-[1.45] has-[>svg]:grid-cols-[17px_1fr] has-[>svg]:gap-x-3 [&>svg]:size-[17px] [&>svg]:translate-y-px",
  {
    variants: {
      variant: {
        default: "border-l-gold [&>svg]:text-gold-text",
        warning: "border-l-feature-event [&>svg]:text-feature-event-text",
        destructive: "border-l-feature-danger [&>svg]:text-feature-danger-text",
        success: "border-l-feature-voice [&>svg]:text-feature-voice-text",
        info: "border-l-feature-thread [&>svg]:text-feature-thread-text",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 line-clamp-1 min-h-4 text-sm font-extrabold text-text-primary", className)}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-text-secondary",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
