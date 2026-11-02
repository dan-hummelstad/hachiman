import * as React from 'react'

import { cn } from '@/lib/utils'

export type FieldSize = 'default' | 'touch'

/**
 * The mobile kit field box (Input, NativeSelect, Textarea): 16 px text, so iOS does not zoom on
 * focus, padding 14 and a 1.5 px focus stroke.
 */
export const TOUCH_FIELD =
  'rounded-[14px] border-line-strong px-4 text-base leading-6 focus-visible:border-line-strong'

/** What a `MobileField` tells the control in it: its id, its helper or error line, the error state. */
interface FieldControl {
  id: string
  describedBy: string | undefined
  invalid: boolean
}

export const FieldControlContext = React.createContext<FieldControl | null>(null)

/**
 * The `id`, `aria-describedby` and `aria-invalid` of the enclosing `MobileField`, to spread before
 * the caller's props (the caller's own values win). Empty outside a `MobileField`.
 */
export function useFieldControl(): {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: true
} {
  const field = React.useContext(FieldControlContext)
  if (!field) return {}
  return {
    id: field.id,
    'aria-describedby': field.describedBy,
    'aria-invalid': field.invalid || undefined
  }
}

/** Left padding of a field with a lead icon: the field padding, the icon and a 8 or 10 gap. */
export const LEAD_PADDING: Record<FieldSize, string> = { default: 'pl-9', touch: 'pl-[44px]' }

/** The lead icon slot of a field: tertiary, at the field's left padding. The parent is `relative`. */
export function FieldLead({
  size,
  children,
  className
}: {
  size: FieldSize
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-slot="field-lead"
      className={cn(
        "text-text-tertiary pointer-events-none absolute top-1/2 left-3 flex -translate-y-1/2 [&_svg:not([class*='size-'])]:size-4",
        size === 'touch' && "left-4 [&_svg:not([class*='size-'])]:size-[17px]",
        className
      )}
    >
      {children}
    </span>
  )
}

function Input({
  className,
  type,
  size = 'default',
  lead,
  ...props
}: Omit<React.ComponentProps<'input'>, 'size'> & {
  /** `touch`: the mobile kit field (48 tall, text 16). */
  size?: FieldSize
  /** An icon at the start of the field. With it, the input sits in a full-width wrapper. */
  lead?: React.ReactNode
}) {
  const field = useFieldControl()
  const input = (
    <input
      {...field}
      type={type}
      data-slot="input"
      className={cn(
        'rounded-control file:text-foreground placeholder:text-text-tertiary selection:bg-here-tint selection:text-text-primary text-text-primary border-line-hairline bg-surface-sunken h-10 w-full min-w-0 border px-3 py-1 text-sm leading-5 transition-colors outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        // Text fields always match :focus-visible, so they get a stronger border instead of an outline.
        'hover:border-line-strong focus-visible:border-line-strong',
        'aria-invalid:border-you',
        size === 'touch' && ['h-[52px]', TOUCH_FIELD],
        lead != null && LEAD_PADDING[size],
        className
      )}
      {...props}
    />
  )
  if (lead == null) return input
  return (
    <span data-slot="input-wrapper" className="relative flex w-full min-w-0">
      <FieldLead size={size}>{lead}</FieldLead>
      {input}
    </span>
  )
}

export { Input }
