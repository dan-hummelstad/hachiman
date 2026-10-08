import * as React from "react"

import { cn } from "@/lib/utils"

// T3 kit input: 44px, sunken fill, strong line, radius/control; gold line + halo on focus,
// danger line on aria-invalid, hover fill when read only.
const fieldBox =
  "flex h-11 w-full min-w-0 items-center gap-2.5 rounded-control border border-line-strong bg-surface-sunken px-3.5 text-[15px] leading-5 font-medium text-text-primary transition-[border-color,box-shadow]"

const inputText =
  "min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-disabled disabled:cursor-not-allowed file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-semibold file:text-text-primary"

const boxStates =
  "has-[input:focus-visible]:focus-gold has-[input[aria-invalid=true]]:border-feature-danger has-[input[aria-invalid=true]]:shadow-none has-[input:read-only]:border-line-hairline has-[input:read-only]:bg-surface-hover has-[input:read-only]:text-text-tertiary has-[input:disabled]:opacity-50"

/** `className` styles the outer box (width, font); the rest of the props go on the <input>. */
export interface InputProps extends React.ComponentProps<"input"> {
  /** Lucide icon (or any node) before the text, in text/tertiary. */
  leading?: React.ReactNode
  /** Node after the text, e.g. a password eye button or an error icon. */
  trailing?: React.ReactNode
}

function Input({ className, type, leading, trailing, ...props }: InputProps) {
  return (
    <div
      data-slot="input-box"
      className={cn(
        fieldBox,
        boxStates,
        "[&_svg]:size-4 [&_svg]:shrink-0 [&>svg]:text-text-tertiary",
        className
      )}
    >
      {leading}
      <input type={type} data-slot="input" className={inputText} {...props} />
      {trailing}
    </div>
  )
}

export { Input }
