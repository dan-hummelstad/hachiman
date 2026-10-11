import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Slot } from '@radix-ui/react-slot'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { SectionLabel } from '@/components/mobile/list'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { SheetBody, SheetContent, SheetTitle } from '@/components/mobile/sheet'
import { LONG_PRESS_TARGET, useLongPress } from '@/hooks/use-long-press'
import { accessibleName } from '@/lib/accessible-name'
import { cn } from '@/lib/utils'

/**
 * The mobile form of every dropdown menu and context menu (spec §2.5): an action sheet with the
 * Radix menu API. `components/ui/dropdown-menu.tsx` and `components/ui/context-menu.tsx` switch to
 * these parts on the mobile layout, so their call sites need no edits. An item is a 48 row that
 * calls `onSelect` and then closes the sheet, unless `onSelect` calls `preventDefault` (as in
 * Radix). A separator starts a new group, a label is a Section Label, and a sub menu pushes inside
 * the sheet.
 */

interface RootValue {
  open: boolean
  setOpen: (open: boolean) => void
  /** The control that opened the sheet: the sheet takes its name. */
  trigger: HTMLElement | null
  setTrigger: (el: HTMLElement | null) => void
}

const RootContext = createContext<RootValue | null>(null)

function useRoot(part: string): RootValue {
  const root = useContext(RootContext)
  if (!root) throw new Error(`${part} must be inside a MenuSheet`)
  return root
}

/** Radix's controlled or uncontrolled `open`: `onOpenChange` runs only on a change. */
function useControllableOpen(
  open: boolean | undefined,
  defaultOpen: boolean,
  onOpenChange: ((open: boolean) => void) | undefined
): [boolean, (open: boolean) => void] {
  const [own, setOwn] = useState(defaultOpen)
  const controlled = open !== undefined
  const value = controlled ? open : own
  const set = useCallback(
    (next: boolean) => {
      if (next === value) return
      if (!controlled) setOwn(next)
      onOpenChange?.(next)
    },
    [value, controlled, onOpenChange]
  )
  return [value, set]
}

export interface MenuSheetProps {
  /** Controlled open. A sortable row opens its hold menu through it (spec §2.9). */
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}

/** The root: a Radix Dialog under the sheet, so focus trap, Escape and the scrim work as a sheet. */
export function MenuSheet({
  open,
  defaultOpen = false,
  onOpenChange,
  children
}: MenuSheetProps): React.JSX.Element {
  const [value, setOpen] = useControllableOpen(open, defaultOpen, onOpenChange)
  const [trigger, setTrigger] = useState<HTMLElement | null>(null)
  const root = useMemo<RootValue>(
    () => ({ open: value, setOpen, trigger, setTrigger }),
    [value, setOpen, trigger]
  )
  return (
    <DialogPrimitive.Root open={value} onOpenChange={setOpen}>
      <RootContext.Provider value={root}>{children}</RootContext.Provider>
    </DialogPrimitive.Root>
  )
}

/**
 * The button that opens the sheet (the dropdown trigger). A tap toggles it. The `Slot` adds the
 * root's ref to the caller's, so a wrapping `TooltipTrigger asChild` keeps its own.
 */
export function MenuSheetTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>
): React.JSX.Element {
  const { setTrigger } = useRoot('MenuSheetTrigger')
  return (
    <Slot ref={setTrigger}>
      <DialogPrimitive.Trigger data-slot="menu-sheet-trigger" {...props} />
    </Slot>
  )
}

/**
 * The context-menu trigger: a hold of 400 ms opens the sheet (`useLongPress`, with a light haptic),
 * and so does a right-click. Radix's own 700 ms touch timer is not in play, so one hold never opens
 * two menus. `longPress={false}` leaves the hold to a sortable row, which opens the menu through
 * the root's `open` when a hold ends without a move.
 */
export function MenuSheetHoldTrigger({
  asChild = false,
  disabled = false,
  longPress = true,
  className,
  onContextMenu,
  ...props
}: React.ComponentProps<'span'> & {
  asChild?: boolean
  disabled?: boolean
  longPress?: boolean
}): React.JSX.Element {
  const { open, setOpen, setTrigger } = useRoot('MenuSheetHoldTrigger')
  const hold = !disabled && longPress
  const press = useLongPress(
    (at) => {
      setTrigger(at.target)
      setOpen(true)
    },
    { enabled: hold }
  )
  const Comp = asChild ? Slot : 'span'
  return (
    <Comp
      data-slot="menu-sheet-hold-trigger"
      data-state={open ? 'open' : 'closed'}
      {...props}
      {...(hold
        ? {
            onPointerDown: press.onPointerDown,
            onPointerMove: press.onPointerMove,
            onPointerUp: press.onPointerUp,
            onPointerCancel: press.onPointerCancel
          }
        : {})}
      onContextMenu={(e: React.MouseEvent<HTMLSpanElement>) => {
        onContextMenu?.(e)
        if (disabled || e.defaultPrevented) return
        // The native menu after a hold that already opened the sheet: swallowed here.
        if (hold) press.onContextMenu(e)
        if (e.defaultPrevented) return
        e.preventDefault()
        setTrigger(e.currentTarget)
        setOpen(true)
      }}
      className={cn(LONG_PRESS_TARGET, className)}
    />
  )
}

interface ActiveSub {
  id: string
  label: React.ReactNode
  /** The sub trigger, which takes the focus back on Back. */
  from: HTMLElement
}

interface ListValue {
  /** Runs an item's select: `onSelect`, then `then`, then closes unless `onSelect` prevented it. */
  select: (onSelect: ((event: Event) => void) | undefined, then?: () => void) => void
  sub: ActiveSub | null
  push: (sub: ActiveSub) => void
  pop: () => void
  /** The layer that a pushed sub menu renders into. */
  slot: HTMLElement | null
}

const ListContext = createContext<ListValue | null>(null)

function useList(part: string): ListValue {
  const list = useContext(ListContext)
  if (!list) throw new Error(`${part} must be inside a MenuSheetContent`)
  return list
}

/**
 * The sheet: the action variant (panel colour, padding 8/12) with a scrolling list. It has no
 * visible title; `title` (else the trigger's name) names it for VoiceOver. Escape in a sub menu
 * goes back first.
 */
export function MenuSheetContent({
  title,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown
}: {
  title?: string
  children?: React.ReactNode
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
  onEscapeKeyDown?: (event: KeyboardEvent) => void
}): React.JSX.Element {
  const { setOpen, trigger } = useRoot('MenuSheetContent')
  const [sub, setSub] = useState<ActiveSub | null>(null)
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)

  const list = useMemo<ListValue>(
    () => ({
      select: (onSelect, then) => {
        const event = new CustomEvent('menu.itemSelect', { cancelable: true })
        onSelect?.(event)
        then?.()
        if (!event.defaultPrevented) setOpen(false)
      },
      sub,
      push: setSub,
      pop: () => {
        const from = sub?.from
        setSub(null)
        // After the list shows again.
        requestAnimationFrame(() => from?.focus({ preventScroll: true }))
      },
      slot
    }),
    [setOpen, sub, slot]
  )

  return (
    <SheetContent
      variant="action"
      aria-describedby={undefined}
      onOpenAutoFocus={onOpenAutoFocus}
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={(e) => {
        onEscapeKeyDown?.(e)
        if (e.defaultPrevented || !sub) return
        e.preventDefault()
        list.pop()
      }}
    >
      <SheetTitle className="sr-only">{title ?? accessibleName(trigger) ?? 'Menu'}</SheetTitle>
      <ListContext.Provider value={list}>
        <SheetBody className="gap-0">
          <div data-slot="menu-sheet-list" hidden={sub !== null} className="flex flex-col">
            {children}
          </div>
          <div
            ref={setSlot}
            data-slot="menu-sheet-pushed"
            hidden={sub === null}
            className="flex flex-col"
          />
        </SheetBody>
      </ListContext.Provider>
    </SheetContent>
  )
}

/**
 * One 48 row: icon 20, label 16/600, an optional hint 13 at the end. Rows sit in square groups
 * with hairline dividers (List Group); a separator or a label ends a group. Destructive rows are
 * red on a red tint.
 */
const ROW = cn(
  'relative flex min-h-12 w-full shrink-0 items-center gap-3.5 px-3.5 py-2 text-left outline-none select-none',
  'text-text-primary text-[16px] leading-5 font-semibold',
  'border-line-hairline border-x border-t bg-white/2',
  'last:border-b [&:has(+[data-slot=menu-sheet-separator])]:border-b [&:has(+[data-slot=menu-sheet-label])]:border-b',
  // A nested group (a radio group) above drew the line already.
  '[[data-slot=menu-sheet-group]+&]:border-t-0',
  'active:bg-surface-hover focus-visible:outline-line-focus focus-visible:outline-2 focus-visible:-outline-offset-2',
  'disabled:pointer-events-none disabled:opacity-50',
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5 [&_svg:not([class*='text-'])]:text-text-secondary",
  "data-[variant=destructive]:border-feature-danger/20 data-[variant=destructive]:bg-feature-danger/5 data-[variant=destructive]:text-feature-danger-text data-[variant=destructive]:[&_svg:not([class*='text-'])]:text-current"
)

/** The hint and the end mark of a row, pushed to the end. */
function RowEnd({
  hint,
  mark
}: {
  hint?: React.ReactNode
  mark?: React.ReactNode
}): React.ReactNode {
  if ((hint === undefined || hint === null) && !mark) return null
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
      {hint !== undefined && hint !== null && (
        <span
          data-slot="menu-hint"
          className="text-text-tertiary text-[13px] leading-4 font-semibold tabular-nums"
        >
          {hint}
        </span>
      )}
      {mark}
    </span>
  )
}

/** The check of a checkbox or radio row (iOS style): hidden while off, so the rows keep a width. */
function CheckMark({ on }: { on: boolean }): React.JSX.Element {
  return <Check aria-hidden className={cn('text-accent-text size-5', !on && 'invisible')} />
}

interface ItemBase {
  children?: React.ReactNode
  disabled?: boolean
  /** Short text at the end of the row ("3 pinned", "Mentions"). Desktop menus do not show it. */
  hint?: React.ReactNode
  className?: string
  'aria-label'?: string
}

export interface MenuSheetItemProps extends ItemBase {
  onSelect?: (event: Event) => void
  variant?: 'default' | 'destructive'
}

export function MenuSheetItem({
  children,
  onSelect,
  disabled,
  variant = 'default',
  hint,
  className,
  'aria-label': ariaLabel
}: MenuSheetItemProps): React.JSX.Element {
  const list = useList('MenuSheetItem')
  return (
    <button
      type="button"
      data-slot="menu-sheet-item"
      data-variant={variant}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() => list.select(onSelect)}
      className={cn(ROW, className)}
    >
      {children}
      <RowEnd hint={hint} />
    </button>
  )
}

export function MenuSheetCheckboxItem({
  children,
  checked = false,
  onCheckedChange,
  onSelect,
  disabled,
  hint,
  className,
  'aria-label': ariaLabel
}: ItemBase & {
  checked?: boolean | 'indeterminate'
  onCheckedChange?: (checked: boolean) => void
  onSelect?: (event: Event) => void
}): React.JSX.Element {
  const list = useList('MenuSheetCheckboxItem')
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === 'indeterminate' ? 'mixed' : checked}
      data-slot="menu-sheet-item"
      data-state={checked === true ? 'checked' : 'unchecked'}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() =>
        list.select(onSelect, () => onCheckedChange?.(checked === 'indeterminate' || !checked))
      }
      className={cn(ROW, className)}
    >
      {children}
      <RowEnd hint={hint} mark={<CheckMark on={checked === true} />} />
    </button>
  )
}

interface RadioValue {
  value?: string
  onValueChange?: (value: string) => void
}

const RadioContext = createContext<RadioValue | null>(null)

const GROUP = 'flex flex-col'

/** A group of radio rows. It is its own List Group. */
export function MenuSheetRadioGroup({
  value,
  onValueChange,
  children,
  'aria-label': ariaLabel
}: RadioValue & { children?: React.ReactNode; 'aria-label'?: string }): React.JSX.Element {
  const radio = useMemo(() => ({ value, onValueChange }), [value, onValueChange])
  return (
    <RadioContext.Provider value={radio}>
      <div role="radiogroup" aria-label={ariaLabel} data-slot="menu-sheet-group" className={GROUP}>
        {children}
      </div>
    </RadioContext.Provider>
  )
}

export function MenuSheetRadioItem({
  value,
  children,
  onSelect,
  disabled,
  hint,
  className,
  'aria-label': ariaLabel
}: ItemBase & { value: string; onSelect?: (event: Event) => void }): React.JSX.Element {
  const list = useList('MenuSheetRadioItem')
  const radio = useContext(RadioContext)
  const on = radio?.value === value
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-slot="menu-sheet-item"
      data-state={on ? 'checked' : 'unchecked'}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() => list.select(onSelect, () => radio?.onValueChange?.(value))}
      className={cn(ROW, className)}
    >
      {children}
      <RowEnd hint={hint} mark={<CheckMark on={on} />} />
    </button>
  )
}

/** Items that belong together (Radix `Group`). It is its own List Group. */
export function MenuSheetGroup({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div role="group" data-slot="menu-sheet-group" className={GROUP}>
      {children}
    </div>
  )
}

/** A Section Label over the next group. */
export function MenuSheetLabel({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <SectionLabel data-slot="menu-sheet-label" className="pb-1.5 not-first:mt-3">
      {children}
    </SectionLabel>
  )
}

/**
 * The gap (12) between two groups. A separator at the start or the end of the list, one after
 * another separator and one before a label draw nothing.
 */
export function MenuSheetSeparator(): React.JSX.Element {
  return (
    <div
      role="separator"
      data-slot="menu-sheet-separator"
      className="h-3 shrink-0 first:hidden last:hidden [[data-slot=menu-sheet-separator]+&]:hidden [&:has(+[data-slot=menu-sheet-label])]:hidden"
    />
  )
}

const SubContext = createContext<string | null>(null)

function useSub(part: string): string {
  const id = useContext(SubContext)
  if (id === null) throw new Error(`${part} must be inside a MenuSheetSub`)
  return id
}

/** A sub menu: its trigger row pushes its content inside the same sheet, with a Back row. */
export function MenuSheetSub({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const id = useId()
  return <SubContext.Provider value={id}>{children}</SubContext.Provider>
}

export function MenuSheetSubTrigger({
  children,
  disabled,
  hint,
  className,
  'aria-label': ariaLabel
}: ItemBase): React.JSX.Element {
  const id = useSub('MenuSheetSubTrigger')
  const list = useList('MenuSheetSubTrigger')
  return (
    <button
      type="button"
      data-slot="menu-sheet-item"
      aria-haspopup="menu"
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={(e) => list.push({ id, label: children, from: e.currentTarget })}
      className={cn(ROW, className)}
    >
      {children}
      <RowEnd hint={hint} mark={<ChevronRight aria-hidden className="text-text-disabled" />} />
    </button>
  )
}

/** Renders into the pushed layer of the sheet while its sub menu is open. */
export function MenuSheetSubContent({
  children
}: {
  children?: React.ReactNode
}): React.ReactPortal | null {
  const id = useSub('MenuSheetSubContent')
  const list = useList('MenuSheetSubContent')
  if (list.sub?.id !== id || !list.slot) return null
  return createPortal(
    <>
      <SubHeader label={list.sub.label} onBack={list.pop} />
      {children}
    </>,
    list.slot
  )
}

/** The Back row of a pushed sub menu: back 36 and the sub menu's label. It takes the focus. */
function SubHeader({
  label,
  onBack
}: {
  label: React.ReactNode
  onBack: () => void
}): React.JSX.Element {
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => back.current?.focus({ preventScroll: true }), [])
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2 pb-2">
      <button
        ref={back}
        type="button"
        aria-label="Back"
        onClick={onBack}
        className={cn(
          KIT_ICON_BUTTON,
          'bg-surface-hover text-text-secondary active:bg-surface-selected'
        )}
      >
        <ChevronLeft />
      </button>
      <span className="text-text-primary flex min-w-0 items-center truncate text-[16px] leading-5 font-extrabold [&_svg]:hidden">
        {label}
      </span>
    </div>
  )
}
