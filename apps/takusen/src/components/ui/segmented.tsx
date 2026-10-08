"use client"

import * as React from "react"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// T3 kit segmented control: a sunken radius/option track; the selected segment is raised
// with a gold icon. Single choice only (e.g. Dark / Light).
function Segmented({
  className,
  value,
  onValueChange,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof ToggleGroupPrimitive.Root>,
  "type" | "value" | "defaultValue" | "onValueChange"
> & {
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      data-slot="segmented"
      value={value}
      // Radix sends "" when the selected item is clicked again; a segmented control keeps it.
      onValueChange={(next) => next && onValueChange(next)}
      className={cn(
        "inline-flex h-9 items-center gap-0.5 rounded-option border border-line-hairline bg-surface-sunken p-[3px]",
        className
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Root>
  )
}

function SegmentedItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="segmented-item"
      className={cn(
        "inline-flex h-full items-center gap-1.5 rounded-[7px] border border-transparent px-3 text-[13px] leading-none font-bold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-text-tertiary",
        "data-[state=on]:border-line-strong data-[state=on]:bg-surface-raised data-[state=on]:font-extrabold data-[state=on]:text-text-primary data-[state=on]:[&_svg]:text-gold-text",
        className
      )}
      {...props}
    />
  )
}

export { Segmented, SegmentedItem }
