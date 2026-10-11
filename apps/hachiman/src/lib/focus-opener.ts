import { isTextField } from '@/lib/text-field'

/**
 * The control that opened a sheet or a pushed screen, so the focus can go back to it on close
 * (spec §2.5, §2.6). `document.activeElement` alone is not enough: in WebKit (iOS, Safari) a tap
 * on a button does not focus it. So one capture listener records the last control that the user
 * activated, and a surface that opens takes that control when the activation is fresh.
 *
 * A text field is never an opener: focus on it would raise the keyboard again.
 *
 * A surface that a sheet's row opens (a confirm, a dialog) outlives that sheet, so its opener is
 * gone by the time it closes. Each sheet records its own opener (`setSheetOpener`), and the focus
 * then goes back along that chain to the first control that is still in the page.
 */

/** An activation older than this (ms) is not what opened the surface. */
export const ACTIVATION_FRESH_MS = 1000

export interface OpenerCandidates<T> {
  /** The focused element, when it can take the focus back (not `<body>`, not a text field). */
  focused: T | null
  /** The last control that the user activated, when it is still in the page. */
  activated: T | null
  /** The time (ms) since that activation. */
  activatedAgo: number
}

export function pickOpener<T>({ focused, activated, activatedAgo }: OpenerCandidates<T>): T | null {
  if (activated !== null && activatedAgo <= ACTIVATION_FRESH_MS) return activated
  return focused ?? activated
}

const ACTIVATABLE =
  'button,a[href],summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=switch],[tabindex]:not([tabindex="-1"])'

let activated: HTMLElement | null = null
let activatedAt = 0

/** The opener of each sheet (`[data-sheet]`) that recorded one. */
const sheetOpeners = new WeakMap<Element, HTMLElement>()
/** For an opener inside a sheet: that sheet's opener, the next step back. */
const fallbacks = new WeakMap<HTMLElement, HTMLElement>()

/** Longest chain of sheets that `restoreFocus` walks back. */
const MAX_CHAIN = 8

/**
 * Records the control that holds `el` as the control the user just activated. For a press that
 * the page swallows before its click reaches the document: a long press, a hold.
 */
export function noteActivation(el: Element): void {
  if (isTextField(el)) return
  const control = el.closest<HTMLElement>(ACTIVATABLE)
  if (!control) return
  activated = control
  activatedAt = performance.now()
}

function record(e: Event): void {
  const target = e.target
  if (!(target instanceof Element)) return
  if (isTextField(target)) activated = null
  else noteActivation(target)
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', record, true)
  document.addEventListener('keydown', record, true)
}

/** The opener of a surface that opens now. Call it before the surface moves the focus. */
export function captureOpener(): HTMLElement | null {
  const active = document.activeElement
  const focused =
    active instanceof HTMLElement && active !== document.body && !isTextField(active)
      ? active
      : null
  const opener = pickOpener({
    focused,
    activated: activated?.isConnected ? activated : null,
    activatedAgo: performance.now() - activatedAt
  })
  const sheet = opener?.closest('[data-sheet]')
  const back = sheet ? sheetOpeners.get(sheet) : undefined
  if (opener && back && back !== opener) fallbacks.set(opener, back)
  return opener
}

/**
 * Records the control that opened `sheet` (a `[data-sheet]` element), so a surface opened from a
 * row of the sheet can give the focus back to it after the sheet has closed.
 */
export function setSheetOpener(sheet: Element, opener: HTMLElement | null): void {
  if (opener) sheetOpeners.set(sheet, opener)
  else sheetOpeners.delete(sheet)
}

const canTakeFocus = (el: HTMLElement | null): el is HTMLElement =>
  el !== null && el.isConnected && el.closest('[inert]') === null

/** The last resort on the mobile layout: the tab strip's sidebar toggle. */
const sidebarToggle = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-slot="sidebar-toggle"]')

const nowhere = (): boolean =>
  document.activeElement === null || document.activeElement === document.body

/**
 * Gives the focus back to `opener` when it is still in the page and not inert, else to the opener
 * of the closed sheet that held it (and so on back). An opener in a closed drawer (the inbox
 * button, the search field) is inert: then the sidebar toggle of the tab strip, which opens that
 * drawer, takes the focus. True when the focus landed.
 */
export function restoreFocus(opener: HTMLElement | null): boolean {
  let el = opener
  for (let i = 0; el && !canTakeFocus(el) && i < MAX_CHAIN; i++) el = fallbacks.get(el) ?? null
  if (canTakeFocus(el)) {
    el.focus({ preventScroll: true })
    if (document.activeElement === el) return true
  }
  const toggle = sidebarToggle()
  if (canTakeFocus(toggle)) {
    toggle.focus({ preventScroll: true })
    return document.activeElement === toggle
  }
  // The tab strip can still be inert while the overlay that covered it goes (its count drops in
  // the same commit): try once more on the next frame, when nothing else took the focus.
  if (toggle)
    requestAnimationFrame(() => {
      const next = sidebarToggle()
      if (nowhere() && canTakeFocus(next)) next.focus({ preventScroll: true })
    })
  return false
}
