import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-control border border-line-strong bg-surface-sunken px-3.5 py-2.5 text-[15px] leading-5 font-medium text-text-primary transition-[border-color,box-shadow] outline-none placeholder:text-text-disabled focus-visible:focus-gold disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-feature-danger",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
