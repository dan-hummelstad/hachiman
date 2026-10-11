import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Slot } from '@radix-ui/react-slot'

import { SheetContent, SheetTitle } from '@/components/mobile/sheet'
import { useLayout } from '@/hooks/use-layout'
import { accessibleName } from '@/lib/accessible-name'
import { cn } from '@/lib/utils'

/**
 * Set under a popover that shows as a bottom sheet (the mobile layout, docs/ios-mobile-ui-spec.md
 * §2.5). The root is then a Radix Dialog, so `open`, `defaultOpen` and `onOpenChange` keep their
 * meaning. The sheet takes the trigger's name.
 */
interface SheetPopoverValue {
  trigger: HTMLElement | null
  setTrigger: (el: HTMLElement | null) => void
}

const SheetPopoverContext = React.createContext<SheetPopoverValue | null>(null)

function Popover({
  inline = false,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root> & {
  /** Mobile layout: keep a small anchored popover instead of a sheet. */
  inline?: boolean
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile && !inline) return <SheetPopover {...props} />
  // An inline popover inside a sheet popover anchors on its own trigger, not the outer sheet.
  return (
    <SheetPopoverContext.Provider value={null}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </SheetPopoverContext.Provider>
  )
}

function SheetPopover({
  open,
  defaultOpen,
  onOpenChange,
  children
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const [trigger, setTrigger] = React.useState<HTMLElement | null>(null)
  const value = React.useMemo(() => ({ trigger, setTrigger }), [trigger])
  return (
    <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <SheetPopoverContext.Provider value={value}>{children}</SheetPopoverContext.Provider>
    </DialogPrimitive.Root>
  )
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const sheet = React.useContext(SheetPopoverContext)
  if (sheet) return <SheetPopoverTrigger setTrigger={sheet.setTrigger} {...props} />
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function SheetPopoverTrigger({
  setTrigger,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger> & {
  setTrigger: (el: HTMLElement | null) => void
}) {
  // The `Slot` adds `setTrigger` to the caller's ref instead of replacing it.
  return (
    <Slot ref={setTrigger}>
      <DialogPrimitive.Trigger data-slot="popover-trigger" {...props} />
    </Slot>
  )
}

/** In a sheet the anchor has no job: it renders its child (or a `div`) as it is. */
function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  const sheet = React.useContext(SheetPopoverContext)
  if (sheet) {
    const { asChild, ...rest } = props
    return asChild ? (
      <Slot data-slot="popover-anchor" {...rest} />
    ) : (
      <div data-slot="popover-anchor" {...rest} />
    )
  }
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const sheet = React.useContext(SheetPopoverContext)
  if (sheet) return <PopoverSheetContent className={className} trigger={sheet.trigger} {...props} />
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) border p-3 shadow-lg outline-hidden',
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

/**
 * The popover as a bottom sheet (pins, threads, profile, emoji, page picker). The caller's
 * `className` styles the body (padding, flex, height) but not its width: the body runs to the
 * sheet's edges and scrolls. Only the focus and dismiss handlers carry over; the popper props
 * (side, align, offsets, collisions) have no meaning here.
 */
function PopoverSheetContent({
  className,
  children,
  trigger,
  'aria-label': ariaLabel,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onPointerDownOutside,
  onFocusOutside,
  onInteractOutside
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { trigger: HTMLElement | null }) {
  return (
    <SheetContent
      aria-label={ariaLabel}
      aria-describedby={undefined}
      onOpenAutoFocus={onOpenAutoFocus}
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={onEscapeKeyDown}
      onPointerDownOutside={onPointerDownOutside}
      onFocusOutside={onFocusOutside}
      onInteractOutside={onInteractOutside}
    >
      <SheetTitle className="sr-only">
        {ariaLabel ?? accessibleName(trigger) ?? 'Details'}
      </SheetTitle>
      <div
        data-slot="popover-sheet-body"
        className={cn(
          className,
          'mx-[calc(var(--sheet-gutter)*-1)] min-h-0 w-auto max-w-none flex-1 overflow-x-hidden overflow-y-auto overscroll-contain'
        )}
      >
        {children}
      </div>
    </SheetContent>
  )
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
