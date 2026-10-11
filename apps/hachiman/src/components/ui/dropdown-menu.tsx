import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react'

import {
  MenuSheet,
  MenuSheetCheckboxItem,
  MenuSheetContent,
  MenuSheetGroup,
  MenuSheetItem,
  MenuSheetLabel,
  MenuSheetRadioGroup,
  MenuSheetRadioItem,
  MenuSheetSeparator,
  MenuSheetSub,
  MenuSheetSubContent,
  MenuSheetSubTrigger,
  MenuSheetTrigger
} from '@/components/mobile/menu-sheet'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'

/*
 * On the mobile layout every part below renders its `components/mobile/menu-sheet` form: the menu
 * is an action sheet with 48 rows (docs/ios-mobile-ui-spec.md §2.5). Popper props (side, align,
 * offsets) and the desktop `className` of the content, labels and separators have no meaning there.
 * An item's `hint` shows only in the sheet.
 */

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <MenuSheet
        open={props.open}
        defaultOpen={props.defaultOpen}
        onOpenChange={props.onOpenChange}
      >
        {props.children}
      </MenuSheet>
    )
  }
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <>{props.children}</>
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetTrigger {...props} />
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
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
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[11rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto border p-1 shadow-lg',
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetGroup>{props.children}</MenuSheetGroup>
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  hint,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
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
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
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

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  hint,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
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
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground rounded-control relative flex cursor-default items-center gap-2 h-8 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
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
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  hint,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
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
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground rounded-control relative flex cursor-default items-center gap-2 h-8 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetLabel>{props.children}</MenuSheetLabel>
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn('section-label px-2 pt-2 pb-1 data-[inset]:pl-8', className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetSeparator />
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return null
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('text-muted-foreground ml-auto text-xs tabular-nums', className)}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetSub>{props.children}</MenuSheetSub>
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
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
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-default items-center gap-2 h-8 px-2 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const mobile = useLayout() === 'mobile'
  if (mobile) return <MenuSheetSubContent>{props.children}</MenuSheetSubContent>
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[11rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden border p-1 shadow-lg',
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
}
