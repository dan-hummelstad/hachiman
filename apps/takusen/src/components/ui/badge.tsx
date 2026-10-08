import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// System tag (ADMIN, YOU, PKCE, E2EE, THIS BROWSER, PREVIEW): square, 20px, 10.5/800 caps.
// Square because it labels structure; nothing here is clickable.
const tagVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center gap-[5px] px-[7px] text-[10.5px] leading-none font-extrabold tracking-[0.6px] whitespace-nowrap uppercase [&>svg]:size-3 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        gold: "bg-gold-tint text-gold-text",
        neutral: "bg-surface-hover text-text-secondary",
        hachiman: "bg-accent-tint text-accent-text",
        info: "bg-feature-thread/15 text-feature-thread-text",
        success: "bg-feature-voice/15 text-feature-voice-text",
        warning: "bg-feature-event/15 text-feature-event-text",
        danger: "bg-feature-danger/15 text-feature-danger-text",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

function Tag({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof tagVariants>) {
  return <span data-slot="tag" className={cn(tagVariants({ tone }), className)} {...props} />
}

// Health status (Healthy, Stale, Draining, Offline): square, dot + sentence-case label.
const statusVariants = cva(
  "inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 px-2 text-xs leading-none font-extrabold whitespace-nowrap before:size-1.5 before:shrink-0 before:rounded-full before:bg-current",
  {
    variants: {
      tone: {
        success: "bg-feature-voice/15 text-feature-voice-text",
        warning: "bg-feature-event/15 text-feature-event-text",
        info: "bg-feature-thread/15 text-feature-thread-text",
        danger: "bg-feature-danger/15 text-feature-danger-text",
        neutral: "bg-surface-hover text-text-tertiary",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

function StatusTag({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusVariants>) {
  return (
    <span data-slot="status-tag" className={cn(statusVariants({ tone }), className)} {...props} />
  )
}

// Count / NEW badge: an 18px pill (counts are touched in nav rows, so rounded).
const badgeVariants = cva(
  "inline-flex h-[18px] min-w-[18px] w-fit shrink-0 items-center justify-center rounded-pill px-1.5 text-[11px] leading-none font-extrabold whitespace-nowrap tabular-nums",
  {
    variants: {
      variant: {
        neutral: "bg-surface-hover text-text-tertiary",
        danger: "bg-feature-danger text-white",
        gold: "bg-gold text-on-gold",
        // Older name, kept until the dashboard moves to Tag.
        secondary: "bg-surface-hover text-text-tertiary",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants, StatusTag, Tag, tagVariants }
