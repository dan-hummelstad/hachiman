import { useEffect, useRef, useSyncExternalStore } from 'react'

/** A keyboard inset over this is the software keyboard, not a toolbar or rounding. */
export const KEYBOARD_MIN_INSET = 80

export interface ViewportMetrics {
  /** The visible height: `--app-height`. */
  appHeight: number
  /** The part of the layout viewport under the visible area (the keyboard): `--kb`. */
  kb: number
}

/**
 * The metrics of a visual viewport. Null while the user has zoomed the page: the visual
 * viewport is then a zoomed part of the page, not the space above the keyboard.
 */
export function viewportMetrics(
  innerHeight: number,
  vv: { height: number; offsetTop: number; scale: number }
): ViewportMetrics | null {
  if (Math.abs(vv.scale - 1) > 0.01) return null
  return { appHeight: vv.height, kb: Math.max(0, innerHeight - vv.height - vv.offsetTop) }
}

let inset = 0
const listeners = new Set<() => void>()

function setInset(next: number): void {
  if (next === inset) return
  inset = next
  for (const notify of listeners) notify()
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

/** The keyboard inset in px (0 on the desktop layout). */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, () => inset)
}

export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribe, () => inset > KEYBOARD_MIN_INSET)
}

/**
 * While `enabled` (the mobile layout), keeps `--app-height`, `--kb` and `data-keyboard="open"`
 * on `<html>` in step with the visual viewport (docs/ios-mobile-ui-spec.md §2.8). The app root
 * takes `--app-height`, so the composer rides on the keyboard. WKWebView scrolls the document
 * to a focused field, so each update scrolls it back to the top.
 */
export function useVisualViewport(enabled: boolean): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!enabled || !vv) return
    const root = document.documentElement
    const update = (): void => {
      const metrics = viewportMetrics(window.innerHeight, vv)
      if (!metrics) return
      root.style.setProperty('--app-height', `${metrics.appHeight}px`)
      root.style.setProperty('--kb', `${metrics.kb}px`)
      if (metrics.kb > KEYBOARD_MIN_INSET) root.dataset.keyboard = 'open'
      else delete root.dataset.keyboard
      setInset(metrics.kb)
      if (window.scrollY !== 0 || vv.offsetTop > 0) window.scrollTo(0, 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      root.style.removeProperty('--app-height')
      root.style.removeProperty('--kb')
      delete root.dataset.keyboard
      setInset(0)
    }
  }, [enabled])
}

/**
 * A field at the foot of a sheet body hides under the sheet foot when the keyboard rises and the
 * sheet shrinks (an iPhone SE has about 360 px above the keyboard). While the keyboard rises over
 * the focused field, this scrolls it to the middle of the sheet body: `nearest` would put it at
 * the body's bottom edge, under the sticky footer, because `scrollIntoView` ignores sticky parts.
 */
export function useRevealOnKeyboard<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T>(null)
  const inset = useKeyboardInset()
  useEffect(() => {
    const el = ref.current
    if (inset > 0 && el && document.activeElement === el) el.scrollIntoView({ block: 'center' })
  }, [inset])
  return ref
}
