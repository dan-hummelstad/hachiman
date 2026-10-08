import * as React from "react"

import { cn } from "@/lib/utils"

// T3 kit chip (table filters): 30px pill, gold tint when selected, optional count.
function Chip({
  className,
  selected = false,
  count,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  selected?: boolean
  count?: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-slot="chip"
      aria-pressed={selected}
      className={cn(
        "inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-pill border px-3 text-[13px] leading-none whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5",
        selected
          ? "border-gold-line bg-gold-tint font-extrabold text-gold-text"
          : "border-line-hairline bg-surface-hover font-bold text-text-secondary hover:text-text-primary",
        className
      )}
      {...props}
    >
      {children}
      {count != null && (
        <span
          className={cn(
            "text-xs font-bold",
            selected ? "text-gold-text opacity-70" : "text-text-tertiary"
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

export { Chip }
