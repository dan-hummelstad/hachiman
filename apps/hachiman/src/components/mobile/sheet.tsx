import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { shouldCommitDrag } from '@/lib/drag-commit'
import { captureOpener, restoreFocus } from '@/lib/focus-opener'
import { cn } from '@/lib/utils'

/** The move (px) before a pointer on the handle counts as a drag or as no drag. */
const DRAG_START = 4

/**
 * Bottom sheet (spec §2.5): full width, square, the top edge in `--line-sheet` with
 * `--shadow-sheet`, padding 8/16 and the home-indicator inset (16 at least), gap 16. It sits on the
 * keyboard (`--kb`) and its top stops 8 px under the status bar. A 250 ms slide up and down; the
 * closed state keeps the last frame until Radix unmounts it. The max-w resets beat a caller's
 * `sm:max-w-*`, because these classes come after the caller's.
 */
const SHEET = cn(
  'fixed inset-x-0 bottom-[var(--kb,0px)] z-50 flex w-full max-w-none sm:max-w-none md:max-w-none lg:max-w-none',
  'max-h-[calc(var(--app-height,100dvh)-var(--safe-top,0px)-8px)] flex-col overflow-hidden',
  'text-text-primary border-x-0 border-t border-b-0 border-(--line-sheet) shadow-(--shadow-sheet) outline-none',
  'px-(--sheet-gutter) pt-2 pb-[max(16px,var(--safe-bottom,0px))] in-data-[keyboard=open]:pb-4',
  'transition-transform duration-250 ease-[cubic-bezier(.32,.72,0,1)]',
  'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=closed]:[--tw-animation-fill-mode:forwards]'
)

/**
 * default: a sheet with a Sheet Header on the content colour (M22, M46). action: a menu or action
 * sheet on the panel colour, padding 8/12, gap 12 (M5, M43).
 */
const VARIANT = {
  default: 'bg-surface-content gap-4 [--sheet-gutter:16px]',
  action: 'bg-surface-panel gap-3 [--sheet-gutter:12px]'
} as const

export type SheetVariant = keyof typeof VARIANT

/** Pointer handlers of a drag zone: the handle row and the Sheet Header. */
interface DragHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
}

interface SheetContextValue {
  drag: DragHandlers
  /** A Sheet Header with a close button mounted; returns the unmount. */
  registerClose: () => () => void
}

const SheetContext = createContext<SheetContextValue | null>(null)

interface DragState {
  pointerId: number
  sheet: HTMLElement
  x: number
  y: number
  /** Past DRAG_START downward: the sheet follows the finger. */
  active: boolean
  offset: number
  lastY: number
  lastT: number
  /** Downward speed in px/ms at the last move. */
  velocity: number
}

/**
 * Swipe down on the handle or the header (spec §2.5). The sheet follows the finger. When
 * `shouldCommitDrag` says so (35 % of the height or a 0.5 px/ms flick), the drag asks to close
 * through the sheet's own close button, so a controlled `onOpenChange` can refuse. A refused or
 * short drag snaps back. An accepted one slides out from where the finger left it (the exit
 * keyframes have no `from`).
 */
function useSheetDrag(close: React.RefObject<HTMLButtonElement | null>): DragHandlers {
  const drag = useRef<DragState | null>(null)
  return useMemo(() => {
    const release = (commit: boolean): void => {
      const d = drag.current
      drag.current = null
      if (!d?.active) return
      const { sheet } = d
      sheet.style.transition = ''
      if (!commit) {
        sheet.style.transform = ''
        return
      }
      close.current?.click()
      // The owner's answer commits before the next frame. Still open: it refused.
      requestAnimationFrame(() => {
        if (sheet.dataset.state !== 'closed') sheet.style.transform = ''
      })
    }
    return {
      onPointerDown: (e) => {
        if (e.button !== 0) return
        const sheet = e.currentTarget.closest<HTMLElement>('[data-sheet]')
        if (!sheet) return
        drag.current = {
          pointerId: e.pointerId,
          sheet,
          x: e.clientX,
          y: e.clientY,
          active: false,
          offset: 0,
          lastY: e.clientY,
          lastT: e.timeStamp,
          velocity: 0
        }
      },
      onPointerMove: (e) => {
        const d = drag.current
        if (!d || d.pointerId !== e.pointerId) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (!d.active) {
          if (dy > DRAG_START && dy > Math.abs(dx)) {
            d.active = true
            e.currentTarget.setPointerCapture(e.pointerId)
            d.sheet.style.transition = 'none'
          } else if (Math.abs(dx) > DRAG_START || dy < -DRAG_START) {
            drag.current = null
          }
          return
        }
        const dt = e.timeStamp - d.lastT
        if (dt > 0) d.velocity = (e.clientY - d.lastY) / dt
        d.lastY = e.clientY
        d.lastT = e.timeStamp
        d.offset = Math.max(0, dy)
        d.sheet.style.transform = `translate3d(0, ${d.offset}px, 0)`
      },
      onPointerUp: (e) => {
        const d = drag.current
        if (!d || d.pointerId !== e.pointerId) return
        release(
          shouldCommitDrag({
            offset: d.offset,
            size: d.sheet.offsetHeight,
            velocity: d.velocity,
            msSinceLastMove: e.timeStamp - d.lastT
          })
        )
      },
      onPointerCancel: () => release(false)
    }
  }, [close])
}

/** The root: a Radix Dialog (focus trap, `aria-modal`, Escape, the scrim closes). */
function Sheet(props: React.ComponentProps<typeof DialogPrimitive.Root>): React.JSX.Element {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>
): React.JSX.Element {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose(props: React.ComponentProps<typeof DialogPrimitive.Close>): React.JSX.Element {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />
}

/**
 * The scrim (`--surface-scrim`, 72 %) and the sheet with its handle row. Works under any Radix
 * Dialog root (`Sheet` or `components/ui/dialog`'s `Dialog`). Put `SheetHeader`, `SheetBody` and
 * `SheetFoot` in it. With no Sheet Header, name the sheet with a `SheetTitle` (`sr-only` is fine).
 * Opening focuses the sheet itself, not its first field, so the keyboard stays down (spec §2.8);
 * a caller's `onOpenAutoFocus` that calls `preventDefault` keeps its own focus. Closing gives the
 * focus back to the control that opened the sheet (`lib/focus-opener`), never to a text field.
 */
function SheetContent({
  variant = 'default',
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  variant?: SheetVariant
}): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const drag = useSheetDrag(close)
  const [closes, setCloses] = useState(0)
  const ctx = useMemo<SheetContextValue>(
    () => ({
      drag,
      registerClose: () => {
        setCloses((n) => n + 1)
        return () => setCloses((n) => n - 1)
      }
    }),
    [drag]
  )

  return (
    <DialogPrimitive.Portal data-slot="sheet-portal">
      <DialogPrimitive.Overlay
        data-slot="sheet-overlay"
        className="bg-surface-scrim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 fixed inset-0 z-50 duration-250"
      />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        data-variant={variant}
        onOpenAutoFocus={(e) => {
          // The focus has not moved yet.
          opener.current = captureOpener()
          onOpenAutoFocus?.(e)
          if (e.defaultPrevented) return
          e.preventDefault()
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e)
          const el = opener.current
          opener.current = null
          if (e.defaultPrevented) return
          // Radix focuses only a `SheetTrigger`; a sheet that a store or a hold menu opened has
          // none, and in WebKit the tapped control never had the focus.
          if (restoreFocus(el)) e.preventDefault()
        }}
        {...props}
        data-sheet=""
        className={cn(className, SHEET, VARIANT[variant])}
      >
        <SheetContext.Provider value={ctx}>
          <div
            aria-hidden
            data-slot="sheet-handle"
            {...drag}
            className={cn(
              "relative flex shrink-0 touch-none items-center justify-center before:absolute before:inset-x-0 before:-top-2 before:-bottom-3 before:content-['']",
              variant === 'default' ? '-mb-0.5 h-2.5' : 'h-3'
            )}
          >
            <span className="h-[5px] w-9 rounded-[3px] bg-(--sheet-handle)" />
          </div>
          {children}
          {/* The drag asks to close through this button. Without a header close it is also the
              VoiceOver way out. */}
          <DialogPrimitive.Close ref={close} hidden={closes > 0} className="sr-only">
            Close
          </DialogPrimitive.Close>
        </SheetContext.Provider>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/**
 * Mobile / Sheet Header (kit J3ZsL1): a 40 feature tile with a 20 icon, title 18/800, subtitle
 * 13/500, close 36. The handle row above it belongs to `SheetContent`. A swipe down on the header
 * drags the sheet like the handle. Without `subtitle`, pass `aria-describedby={undefined}` to
 * `SheetContent` (as `ModalWindow` does), or Radix warns.
 */
function SheetHeader({
  icon,
  feature = 'accent',
  title,
  subtitle,
  close = true,
  closeLabel = 'Close',
  className
}: {
  icon?: React.ReactNode
  feature?: Feature
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** False hides the close button (the sheet then keeps an sr-only one). */
  close?: boolean
  closeLabel?: string
  className?: string
}): React.JSX.Element {
  const sheet = useContext(SheetContext)
  useLayoutEffect(() => (sheet && close ? sheet.registerClose() : undefined), [sheet, close])
  return (
    <div
      data-slot="sheet-header"
      {...sheet?.drag}
      className={cn('flex shrink-0 touch-none items-center gap-3', className)}
    >
      {icon && (
        <span
          aria-hidden
          className={cn(
            'flex size-10 shrink-0 items-center justify-center [&_svg]:size-5',
            FEATURE_TILE[feature]
          )}
        >
          {icon}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <DialogPrimitive.Title className="text-text-primary text-[18px] leading-[22px] font-extrabold">
          {title}
        </DialogPrimitive.Title>
        {subtitle && (
          <DialogPrimitive.Description className="text-text-tertiary text-[13px] leading-4 font-medium">
            {subtitle}
          </DialogPrimitive.Description>
        )}
      </div>
      {close && (
        <DialogPrimitive.Close
          aria-label={closeLabel}
          className={cn(
            KIT_ICON_BUTTON,
            'bg-surface-hover text-text-secondary active:bg-surface-selected [&_svg]:size-[18px]'
          )}
        >
          <XIcon />
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

/** The title of a sheet with no Sheet Header (action and menu sheets): usually `sr-only`. */
function SheetTitle(props: React.ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element {
  return <DialogPrimitive.Title data-slot="sheet-title" {...props} />
}

function SheetDescription(
  props: React.ComponentProps<typeof DialogPrimitive.Description>
): React.JSX.Element {
  return <DialogPrimitive.Description data-slot="sheet-description" {...props} />
}

/**
 * The part of a sheet that scrolls when the sheet reaches its max height. It runs to the sheet's
 * edges, so the content scrolls under the edge and not inside a box.
 */
function SheetBody({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        'mx-[calc(var(--sheet-gutter)*-1)] flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-(--sheet-gutter)',
        className
      )}
      {...props}
    />
  )
}

/** The actions at the foot of a sheet: they stay put while the body scrolls. Primary last. */
function SheetFoot({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="sheet-foot"
      className={cn('flex shrink-0 flex-col gap-1.5', className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFoot,
  SheetHeader,
  SheetTitle,
  SheetTrigger
}
