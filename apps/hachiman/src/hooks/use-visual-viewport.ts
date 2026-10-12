import { useEffect, useSyncExternalStore } from 'react'

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
 * viewport is then a zoomed part of the page, not the space above the keyboard. `kb` ignores
 * `offsetTop`: the update scrolls the document back to the top, so at rest the visual viewport
 * starts at 0.
 */
export function viewportMetrics(
  layoutHeight: number,
  vv: { height: number; offsetTop: number; scale: number }
): ViewportMetrics | null {
  if (Math.abs(vv.scale - 1) > 0.01) return null
  return { appHeight: vv.height, kb: Math.max(0, layoutHeight - vv.height) }
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
 * to a focused field, so each update scrolls it back to the top, and then brings the focused
 * field into view in its own scroller (`revealFocusedField`).
 */
export function useVisualViewport(enabled: boolean): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!enabled || !vv) return
    const root = document.documentElement
    // iOS 26 shrinks `innerHeight` to the visual viewport while it scrolls the document to a
    // focused field, and keeps it there for a second or more with no event. Read the layout height
    // only on a window resize (rotation, the Safari bars), never on a keyboard event, or `--kb`
    // falls back to 0 and the sheets drop under the keyboard.
    let layoutHeight = window.innerHeight
    const update = (): void => {
      const metrics = viewportMetrics(layoutHeight, vv)
      if (!metrics) return
      root.style.setProperty('--app-height', `${metrics.appHeight}px`)
      root.style.setProperty('--kb', `${metrics.kb}px`)
      if (metrics.kb > KEYBOARD_MIN_INSET) root.dataset.keyboard = 'open'
      else delete root.dataset.keyboard
      setInset(metrics.kb)
      if (window.scrollY !== 0 || vv.offsetTop > 0) window.scrollTo(0, 0)
      if (metrics.kb > KEYBOARD_MIN_INSET) revealFocusedField(metrics.appHeight)
    }
    const onWindowResize = (): void => {
      layoutHeight = window.innerHeight
      update()
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('resize', onWindowResize)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('resize', onWindowResize)
      root.style.removeProperty('--app-height')
      root.style.removeProperty('--kb')
      delete root.dataset.keyboard
      setInset(0)
    }
  }, [enabled])
}

/**
 * Scrolls the focused text field to the middle of its scroller when the keyboard, or the edge of
 * that scroller, hides it: a field low in a sheet body goes under the sheet foot when the keyboard
 * rises and the sheet shrinks (an iPhone SE has about 360 px above the keyboard). `nearest` would
 * leave it at the body's bottom edge, under a sticky footer, because `scrollIntoView` ignores
 * sticky parts. A field in view does not move, so the composer and the page editor stay put.
 */
function revealFocusedField(visibleHeight: number): void {
  const el = document.activeElement
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  let bottom = visibleHeight
  let top = 0
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    const box = p.getBoundingClientRect()
    bottom = Math.min(bottom, box.bottom)
    top = Math.max(top, box.top)
    break
  }
  const r = el.getBoundingClientRect()
  if (r.bottom > bottom || r.top < top) el.scrollIntoView({ block: 'center' })
}
