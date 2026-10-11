import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MouseSensor,
  PointerSensor,
  TouchSensor,
  useDndMonitor,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { LONG_PRESS_TARGET } from '@/hooks/use-long-press'
import { useLayout } from '@/hooks/use-layout'
import { noteActivation } from '@/lib/focus-opener'
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from '@/lib/long-press'
import { usePlatform } from '@/shared/PlatformContext'

/** Desktop: a drag starts after 4 px, so a click stays a click. */
const POINTER = { activationConstraint: { distance: 4 } }
/** Mobile layout, a mouse (a narrow browser window): as on desktop. */
const MOUSE = POINTER
/**
 * Mobile layout, a finger (spec §2.9): a drag starts after a 400 ms hold that moves at most 8 px.
 * A finger that moves sooner scrolls the list (or the tab strip) and drags nothing.
 */
const TOUCH = { activationConstraint: { delay: LONG_PRESS_MS, tolerance: LONG_PRESS_SLOP } }

/** After a touch drag ends, the click of that lift comes within this time or not at all. */
const CLICK_WINDOW_MS = 600

/**
 * Classes for the drag handle of a sortable row on the mobile layout: no double-tap zoom wait, no
 * text selection and no iOS callout under a holding finger.
 */
export const SORTABLE_TOUCH = `mobile:touch-manipulation ${LONG_PRESS_TARGET}`

/**
 * The sensors of every sortable list. Desktop: one pointer sensor that starts after 4 px. Mobile
 * layout: a mouse sensor with the same rule and a touch sensor that starts after a hold.
 */
export function useDragSensors(): ReturnType<typeof useSensors> {
  const mobile = useLayout() === 'mobile'
  const pointer = useSensor(PointerSensor, POINTER)
  const mouse = useSensor(MouseSensor, MOUSE)
  const touch = useSensor(TouchSensor, TOUCH)
  // A fixed argument count: useSensors memoizes on its arguments, and null ones drop out.
  return useSensors(mobile ? null : pointer, mobile ? mouse : null, mobile ? touch : null)
}

/**
 * One row of a sortable list, with its drag style: lifted above its neighbours and dimmed while
 * dragged. `translateOnly` keeps the row's size (tabs of different widths).
 */
export function useSortableRow({
  id,
  disabled,
  translateOnly = false,
  dim = !translateOnly
}: {
  id: string
  disabled?: boolean
  translateOnly?: boolean
  /** Default: true unless `translateOnly`. */
  dim?: boolean
}): Omit<ReturnType<typeof useSortable>, 'transform' | 'transition'> & {
  style: React.CSSProperties
} {
  const { transform, transition, ...sortable } = useSortable({ id, disabled })
  const style: React.CSSProperties = {
    transform: (translateOnly ? CSS.Translate : CSS.Transform).toString(transform),
    transition,
    opacity: dim && sortable.isDragging ? 0.5 : undefined,
    zIndex: sortable.isDragging ? 1 : undefined
  }
  return { ...sortable, style }
}

/** The drag was started by a finger or a pen (the touch sensor), not a mouse. */
export function isTouchDrag(activatorEvent: Event | null): boolean {
  return activatorEvent !== null && 'touches' in activatorEvent
}

/**
 * The end of a drag on a sortable row (spec §2.9): a touch drag that ends where it started was a
 * hold, and opens the row's hold menu. Any other end is a drop (a reorder, or nothing).
 */
export function holdEndOpensMenu(touch: boolean, delta: { x: number; y: number }): boolean {
  return touch && Math.hypot(delta.x, delta.y) <= LONG_PRESS_SLOP
}

/**
 * A cancel of a touch drag that the hold had started. iOS WKWebView can end a still hold with
 * `touchcancel` instead of `touchend` (a native gesture takes the touch), and it fires no
 * `contextmenu`. So a cancel with no move is a hold too, while the page is in view. A cancel
 * because the app went to the background opens nothing.
 */
export function holdCancelOpensMenu(
  touch: boolean,
  delta: { x: number; y: number },
  visible: boolean
): boolean {
  return visible && holdEndOpensMenu(touch, delta)
}

/**
 * While a finger drags a row, the pointer moves of that touch stop at the window. The drawer swipe
 * of the mobile shell listens to pointer events and would otherwise close the drawer under a tile
 * that moves to the left. The drag itself runs on touch events.
 */
function holdPointerMoves(): () => void {
  const stop = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') e.stopPropagation()
  }
  const opts = { capture: true } as const
  window.addEventListener('pointermove', stop, opts)
  return () => window.removeEventListener('pointermove', stop, opts)
}

/**
 * Swallows the click that the lift of a touch drag can make, so a hold does not also tap the row.
 * A new touch, or the end of the window, ends it.
 */
function swallowLiftClick(): void {
  const opts = { capture: true } as const
  const end = (): void => {
    clearTimeout(timer)
    window.removeEventListener('click', onClick, opts)
    window.removeEventListener('pointerdown', end, opts)
  }
  const onClick = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    end()
  }
  window.addEventListener('click', onClick, opts)
  window.addEventListener('pointerdown', end, opts)
  const timer = setTimeout(end, CLICK_WINDOW_MS)
}

export interface SortableHoldMenu {
  /** For the row's `ContextMenu`: the hold menu, open after a hold that ends with no move. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * For the row's `ContextMenuTrigger`: false while the row is sortable, because the touch sensor
   * holds it then. A row that cannot be dragged keeps the trigger's own long press.
   */
  longPress: boolean
}

/**
 * Hold on a sortable row (spec §2.9): the touch sensor starts a drag after a 400 ms hold, with a
 * light haptic. A drag that moves reorders (the list's `onDragEnd`); a drag that ends with no move
 * opens the row's hold menu, and so does a still hold that iOS cancels (`holdCancelOpensMenu`). So
 * "hold and release" gives the menu and "hold and move" reorders. The click of the lift is swallowed. Call it in the component of row `id`, inside the list's
 * `DndContext`. `sortable` false: the row cannot be dragged (no permission).
 */
export function useSortableHoldMenu(id: string, { sortable = true } = {}): SortableHoldMenu {
  const platform = usePlatform()
  const [open, setOpen] = useState(false)
  const latest = useRef({ id, platform })
  useEffect(() => {
    latest.current = { id, platform }
  })
  const release = useRef<(() => void) | null>(null)
  useEffect(() => () => release.current?.(), [])

  const monitor = useMemo(() => {
    const end = (): void => {
      release.current?.()
      release.current = null
    }
    const openFrom = (activatorEvent: Event | null): void => {
      // The lift click never reaches the document: the held row is the menu's opener.
      if (activatorEvent?.target instanceof Element) noteActivation(activatorEvent.target)
      setOpen(true)
    }
    return {
      onDragStart: ({ active, activatorEvent }: DragStartEvent): void => {
        if (active.id !== latest.current.id || !isTouchDrag(activatorEvent)) return
        latest.current.platform.haptic('light')
        end()
        release.current = holdPointerMoves()
      },
      onDragEnd: ({ active, activatorEvent, delta }: DragEndEvent): void => {
        if (active.id !== latest.current.id) return
        end()
        const touch = isTouchDrag(activatorEvent)
        if (touch) swallowLiftClick()
        if (holdEndOpensMenu(touch, delta)) openFrom(activatorEvent)
      },
      onDragCancel: ({ active, activatorEvent, delta }: DragCancelEvent): void => {
        if (active.id !== latest.current.id) return
        end()
        const visible = document.visibilityState === 'visible'
        if (holdCancelOpensMenu(isTouchDrag(activatorEvent), delta, visible)) {
          openFrom(activatorEvent)
        }
      }
    }
  }, [])
  useDndMonitor(monitor)

  return { open, onOpenChange: setOpen, longPress: !sortable }
}
