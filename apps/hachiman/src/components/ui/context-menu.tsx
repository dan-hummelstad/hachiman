'use client'

import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react'

import {
  MenuSheet,
  MenuSheetCheckboxItem,
  MenuSheetContent,
  MenuSheetGroup,
  MenuSheetHoldTrigger,
  MenuSheetItem,
  MenuSheetLabel,
  MenuSheetRadioGroup,
  MenuSheetRadioItem,
  MenuSheetSeparator,
  MenuSheetSub,
  MenuSheetSubContent,
  MenuSheetSubTrigger
} from '@/components/mobile/menu-sheet'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'

/*
 * On the mobile layout every part below renders its `components/mobile/menu-sheet` form: a hold of
 * 400 ms on the trigger opens an action sheet with 48 rows (docs/ios-mobile-ui-spec.md §2.5, §2.9).
 * The desktop `className` of the content, labels and separators has no meaning there. An item's
 * `hint` shows only in the sheet.
 */

function ContextMenu({
  open,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root> & {
  /**
   * Mobile layout only: opens the sheet from outside, for the hold menu of a sortable row (a hold
   * that ends without a move). Radix's desktop context menu has no controlled open.
   */
  open?: boolean
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <MenuSheet open={open} onOpenChange={props.onOpenChange}>
        {props.children}
      </MenuSheet>
    )
  }
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  longPress,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger> & {
  /**
   * Mobile layout: false leaves the hold to a sortable row, which opens the menu through the
   * root's `open`. A right-click still opens it. Default true.
   */
  longPress?: boolean
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetHoldTrigger longPress={longPress} {...props} />
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetGroup>{props.children}</MenuSheetGroup>
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
}

function ContextMenuPortal({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <>{props.children}</>
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetSub>{props.children}</MenuSheetSub>
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <MenuSheetRadioGroup
        value={props.value}
        onValueChange={props.onValueChange}
        aria-label={props['aria-label']}
      >
        {props.children}
      </MenuSheetRadioGroup>
    )
  }
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <MenuSheetSubTrigger
        disabled={props.disabled}
        aria-label={props['aria-label']}
        className={className}
      >
        {children}
      </MenuSheetSubTrigger>
    )
  }
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center gap-2 h-8 px-2 text-sm outline-hidden select-none data-[inset]:pl-8',
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetSubContent>{props.children}</MenuSheetSubContent>
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      className={cn(
        'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-50 min-w-[11rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden border p-1 shadow-lg',
        className
      )}
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <MenuSheetContent
        title={props['aria-label']}
        onCloseAutoFocus={props.onCloseAutoFocus}
        onEscapeKeyDown={props.onEscapeKeyDown}
      >
        {props.children}
      </MenuSheetContent>
    )
  }
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-context-menu-content-available-height) min-w-[11rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto border p-1 shadow-lg',
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  hint,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
  /** Short text at the end of the row in the mobile sheet ("3 pinned"). */
  hint?: React.ReactNode
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <MenuSheetItem
        variant={variant}
        hint={hint}
        onSelect={props.onSelect}
        disabled={props.disabled}
        aria-label={props['aria-label']}
        className={className}
      >
        {props.children}
      </MenuSheetItem>
    )
  }
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-current [&_svg:not([class*='text-'])]:text-muted-foreground rounded-control relative flex cursor-default items-center gap-2 h-8 px-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  hint,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  /** Short text at the end of the row in the mobile sheet. */
  hint?: React.ReactNode
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <MenuSheetCheckboxItem
        checked={checked}
        onCheckedChange={props.onCheckedChange}
        onSelect={props.onSelect}
        disabled={props.disabled}
        hint={hint}
        aria-label={props['aria-label']}
        className={className}
      >
        {children}
      </MenuSheetCheckboxItem>
    )
  }
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 h-8 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioItem({
  className,
  children,
  hint,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem> & {
  /** Short text at the end of the row in the mobile sheet. */
  hint?: React.ReactNode
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <MenuSheetRadioItem
        value={props.value}
        onSelect={props.onSelect}
        disabled={props.disabled}
        hint={hint}
        aria-label={props['aria-label']}
        className={className}
      >
        {children}
      </MenuSheetRadioItem>
    )
  }
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 h-8 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetLabel>{props.children}</MenuSheetLabel>
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn('section-label px-2 pt-2 pb-1 data-[inset]:pl-8', className)}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetSeparator />
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup
}
