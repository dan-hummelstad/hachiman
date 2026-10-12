import { useEffect, useRef } from 'react'
import { useDrawerState } from '@/components/mobile/drawer-state'
import {
  EDGE_PX,
  SWIPE_IDLE,
  drawerWidth,
  openShare,
  swipeStep,
  type SwipeInput,
  type SwipeIntent,
  type SwipeOutput,
  type SwipeState
} from '@/lib/swipe'
import { isTextField } from '@/lib/text-field'

/** The widest left safe inset (a phone in landscape) plus a margin. */
const MAX_SAFE_LEFT = 64
/** A click this soon after a drag is the lift of that drag: swallow it. */
const CLICK_WINDOW_MS = 350
/** A pushed screen's slide out (250) and a margin. */
const SLIDE_OUT_MS = 400

/** An open sheet, dialog or menu (Radix): no swipe runs under it. The drawers do not count. */
const OPEN_LAYER =
  ':is([role=dialog],[role=alertdialog],[role=menu],[role=listbox])[data-state=open]:not([data-slot=drawer])'

/** The left safe inset in px (0 in portrait). Only read when a touch starts near the edge. */
function safeLeft(): number {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding-left:env(safe-area-inset-left,0px)'
  document.body.append(probe)
  const inset = parseFloat(getComputedStyle(probe).paddingLeft) || 0
  probe.remove()
  return inset
}

/** `target` sits in a text field, `[data-swipe-ignore]` or a scroller that scrolls sideways. */
function ignores(target: Element, root: HTMLElement): boolean {
  if (isTextField(target) || target.closest('[data-swipe-ignore]')) return true
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue
    const overflow = getComputedStyle(el).overflowX
    if (overflow === 'auto' || overflow === 'scroll') return true
  }
  return false
}

/** The pushed screen on top (not inert, not sliding out), whose Back the edge swipe runs. */
function topScreen(root: HTMLElement): HTMLElement | null {
  const screens = root.querySelectorAll<HTMLElement>('[data-slot=pushed-screen][data-state=open]')
  for (let i = screens.length - 1; i >= 0; i--) {
    const screen = screens[i]
    if (screen && !screen.closest('[inert]')) return screen
  }
  return null
}

const backButton = (screen: HTMLElement): HTMLButtonElement | null =>
  screen.querySelector<HTMLButtonElement>(':scope > [data-slot=nav-bar] > button:first-child')

export interface SwipeFacts {
  /** A pushed screen shows: the left edge means Back. */
  pushed: boolean
  /** The right drawer has something to show. */
  hasRight: boolean
}

/**
 * The drawer and Back swipes on the MobileShell `root` (docs/ios-mobile-ui-spec.md §2.4), over the
 * pure machine in `lib/swipe.ts`. Touch and pen only. A drawer follows the finger through
 * `useDrawerState().drag`; a pushed screen through its inline transform. At the lift the drawer
 * opens or closes, or the screen's Back button runs; else it snaps back. Sheets and dialogs live
 * in portals outside `root`, and no swipe starts while one is open.
 */
export function useSwipe(root: React.RefObject<HTMLElement | null>, facts: SwipeFacts): void {
  const latest = useRef(facts)
  useEffect(() => {
    latest.current = facts
  })

  useEffect(() => {
    const el = root.current
    if (!el) return
    let state: SwipeState = SWIPE_IDLE
    let pointerId: number | null = null
    let screen: HTMLElement | null = null
    let swallowUntil = 0

    const showBack = (progress: number): void => {
      if (!screen) return
      screen.style.transform = `translate3d(${progress * window.innerWidth}px, 0, 0)`
    }

    const finishBack = (commit: boolean): void => {
      const s = screen
      screen = null
      if (!s) return
      const back = commit ? backButton(s) : null
      if (!back) {
        s.style.transform = ''
        return
      }
      // The slide out starts where the finger left the screen (its keyframes have no `from`).
      back.click()
      const clear = (): void => {
        s.style.transform = ''
      }
      requestAnimationFrame(() => {
        // Still open: the owner refused the Back. Snap back.
        if (s.dataset.state === 'open') return clear()
        // Else clear it once the slide out is over, so a screen that opens again in the same
        // node does not keep it.
        const onEnd = (e: AnimationEvent): void => {
          if (e.target !== s) return
          s.removeEventListener('animationend', onEnd)
          clear()
        }
        s.addEventListener('animationend', onEnd)
        setTimeout(() => {
          s.removeEventListener('animationend', onEnd)
          clear()
        }, SLIDE_OUT_MS)
      })
    }

    const drag = (intent: Exclude<SwipeIntent, { kind: 'back' }>, progress: number): void =>
      useDrawerState.setState({ drag: { side: intent.side, share: openShare(intent, progress) } })

    const apply = (out: SwipeOutput): void => {
      if (!out) return
      const { intent } = out
      if (out.kind === 'end') {
        swallowUntil = performance.now() + CLICK_WINDOW_MS
        if (intent.kind === 'back') return finishBack(out.commit)
        const open = useDrawerState.getState().open
        const next = out.commit ? (intent.kind === 'open' ? intent.side : null) : open
        useDrawerState.setState({ open: next, drag: null })
        return
      }
      if (intent.kind === 'back') {
        if (out.kind === 'lock') screen = topScreen(el)
        return showBack(out.progress)
      }
      drag(intent, out.progress)
    }

    const step = (input: SwipeInput): SwipeOutput => {
      const s = swipeStep(state, input)
      state = s.state
      return s.out
    }

    const onDown = (e: PointerEvent): void => {
      // The click of the last drag comes before this touch, or never (WebKit sends none after a
      // drag): either way the guard is done, and this touch's own tap must reach its target.
      swallowUntil = 0
      if (pointerId !== null || !e.isPrimary) return
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      if (!(e.target instanceof Element) || document.querySelector(OPEN_LAYER)) return
      const width = window.innerWidth
      const out = step({
        type: 'down',
        env: {
          open: useDrawerState.getState().open,
          pushed: latest.current.pushed,
          hasRight: latest.current.hasRight,
          edge: EDGE_PX + (e.clientX < EDGE_PX + MAX_SAFE_LEFT ? safeLeft() : 0),
          drawerWidth: drawerWidth(width),
          screenWidth: width
        },
        start: {
          x: e.clientX,
          y: e.clientY,
          ignore: ignores(e.target, el),
          inChat: e.target.closest('[data-swipe-area=chat]') !== null
        }
      })
      if (state.phase !== 'idle') pointerId = e.pointerId
      apply(out)
    }

    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      const out = step({ type: 'move', x: e.clientX, y: e.clientY, t: e.timeStamp })
      if (out?.kind === 'lock') el.setPointerCapture(e.pointerId)
      if (state.phase === 'idle') pointerId = null
      apply(out)
    }

    const onEnd = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      pointerId = null
      apply(step(e.type === 'pointerup' ? { type: 'up', t: e.timeStamp } : { type: 'cancel' }))
    }

    const onClick = (e: MouseEvent): void => {
      if (performance.now() > swallowUntil) return
      swallowUntil = 0
      e.preventDefault()
      e.stopPropagation()
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onEnd)
    el.addEventListener('pointercancel', onEnd)
    el.addEventListener('click', onClick, true)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onEnd)
      el.removeEventListener('pointercancel', onEnd)
      el.removeEventListener('click', onClick, true)
      if (state.phase === 'dragging') apply(step({ type: 'cancel' }))
    }
  }, [root])
}
