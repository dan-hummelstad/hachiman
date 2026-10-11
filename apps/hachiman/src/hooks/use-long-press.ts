import { useEffect, useMemo, useRef } from 'react'
import { noteActivation } from '@/lib/focus-opener'
import {
  LONG_PRESS_IDLE,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  longPressStep,
  type LongPressInput,
  type LongPressPhase
} from '@/lib/long-press'
import type { IPlatformService } from '@/shared/IPlatformService'
import { usePlatform } from '@/shared/PlatformContext'

/**
 * Classes for a long-press target: no text selection and no iOS callout under the finger.
 * "Copy text" in the action sheet takes the place of selection (spec §2.9).
 */
export const LONG_PRESS_TARGET = 'mobile:select-none mobile:[-webkit-touch-callout:none]'

/** After a fire and a lift, the click of that lift comes within this time or not at all. */
const CLICK_WINDOW_MS = 600

/** Where a long press fired: the point where it started, and the element that has the handlers. */
export interface LongPressPoint {
  x: number
  y: number
  target: HTMLElement
}

export interface LongPressOptions {
  /** The hold time (default 400). */
  ms?: number
  /** The move in CSS px that cancels the press (default 8). */
  slop?: number
  /** False: the handlers do nothing (for example on the desktop layout). Default true. */
  enabled?: boolean
}

/** Spread these on the target. */
export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void
}

interface Latest {
  onFire: (at: LongPressPoint) => void
  ms: number
  slop: number
  platform: IPlatformService
}

interface Press {
  input: (input: LongPressInput, event?: Event | React.SyntheticEvent, el?: HTMLElement) => void
  dispose: () => void
}

/**
 * One press machine with its timer and its window listeners: scroll cancels a press; after a
 * fire, the next click anywhere is swallowed, and a new touch anywhere ends that window.
 */
function createPress(latest: { current: Latest }): Press {
  let state = LONG_PRESS_IDLE
  let target: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let unlisten: (() => void) | null = null

  const stopTimer = (): void => {
    clearTimeout(timer)
    timer = undefined
  }

  const onScroll = (): void => input({ type: 'cancel' })
  const onClick = (e: Event): void => input({ type: 'click' }, e)
  const onDown = (): void => input({ type: 'cancel' })

  /** The window listeners of a phase. */
  const listen = (phase: LongPressPhase): void => {
    unlisten?.()
    unlisten = null
    const opts = { capture: true, passive: true } as const
    if (phase === 'pressing') {
      window.addEventListener('scroll', onScroll, opts)
      unlisten = () => window.removeEventListener('scroll', onScroll, opts)
    } else if (phase === 'held' || phase === 'released') {
      // Capture on window runs before React's root listener, so the swallow reaches no handler.
      window.addEventListener('click', onClick, { capture: true })
      if (phase === 'released') window.addEventListener('pointerdown', onDown, opts)
      unlisten = () => {
        window.removeEventListener('click', onClick, { capture: true })
        window.removeEventListener('pointerdown', onDown, opts)
      }
    }
  }

  function input(i: LongPressInput, event?: Event | React.SyntheticEvent, el?: HTMLElement): void {
    const before = state.phase
    const { state: next, effect } = longPressStep(state, i, latest.current.slop)
    state = next
    // Any step out of 'released' ends its click window, before a new hold timer can start.
    if (before === 'released' && next.phase !== 'released') stopTimer()
    if (i.type === 'down' && next.phase === 'pressing' && el) target = el
    switch (effect) {
      case 'startTimer':
        stopTimer()
        timer = setTimeout(() => input({ type: 'timeout' }), latest.current.ms)
        break
      case 'stopTimer':
        stopTimer()
        break
      case 'fire':
        timer = undefined
        if (target) {
          // The click of the lift is swallowed, so the opener of what opens now is noted here.
          noteActivation(target)
          latest.current.platform.haptic('light')
          latest.current.onFire({ x: next.x, y: next.y, target })
        }
        break
      case 'swallow':
        event?.preventDefault()
        event?.stopPropagation()
        break
    }
    if (next.phase === before) return
    listen(next.phase)
    if (next.phase === 'released') {
      timer = setTimeout(() => input({ type: 'cancel' }), CLICK_WINDOW_MS)
    }
    if (next.phase === 'idle') target = null
  }

  return {
    input,
    dispose: () => {
      stopTimer()
      unlisten?.()
      unlisten = null
      state = LONG_PRESS_IDLE
      target = null
    }
  }
}

/**
 * Long press for touch and pen (spec §2.9): `onFire` runs after `ms` of holding still, with a
 * light haptic. The click that the lift then makes and the native `contextmenu` are swallowed. A
 * mouse never fires; desktop right-click stays with the context menu. Give the target the
 * `LONG_PRESS_TARGET` classes. iOS fires no `contextmenu`, so nothing here depends on it.
 */
export function useLongPress(
  onFire: (at: LongPressPoint) => void,
  { ms = LONG_PRESS_MS, slop = LONG_PRESS_SLOP, enabled = true }: LongPressOptions = {}
): LongPressHandlers {
  const platform = usePlatform()
  const latest = useRef<Latest>({ onFire, ms, slop, platform })
  useEffect(() => {
    latest.current = { onFire, ms, slop, platform }
  })

  const press = useRef<Press | null>(null)
  useEffect(() => {
    if (!enabled) return
    const p = createPress(latest)
    press.current = p
    return () => {
      p.dispose()
      press.current = null
    }
  }, [enabled])

  return useMemo(
    () => ({
      onPointerDown: (e) =>
        press.current?.input(
          {
            type: 'down',
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            x: e.clientX,
            y: e.clientY
          },
          e,
          e.currentTarget
        ),
      onPointerMove: (e) =>
        press.current?.input({ type: 'move', pointerId: e.pointerId, x: e.clientX, y: e.clientY }),
      onPointerUp: (e) => press.current?.input({ type: 'up', pointerId: e.pointerId }),
      onPointerCancel: () => press.current?.input({ type: 'cancel' }),
      onContextMenu: (e) => press.current?.input({ type: 'contextmenu' }, e)
    }),
    []
  )
}
