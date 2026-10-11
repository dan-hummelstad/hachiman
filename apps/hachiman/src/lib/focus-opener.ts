import { isTextField } from '@/lib/text-field'

/**
 * The control that opened a sheet or a pushed screen, so the focus can go back to it on close
 * (spec §2.5, §2.6). `document.activeElement` alone is not enough: in WebKit (iOS, Safari) a tap
 * on a button does not focus it. So one capture listener records the last control that the user
 * activated, and a surface that opens takes that control when the activation is fresh.
 *
 * A text field is never an opener: focus on it would raise the keyboard again.
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

/** A fresh activation, else the focused element, else an older activation. */
export function pickOpener<T>({ focused, activated, activatedAgo }: OpenerCandidates<T>): T | null {
  if (activated !== null && activatedAgo <= ACTIVATION_FRESH_MS) return activated
  return focused ?? activated
}

const ACTIVATABLE =
  'button,a[href],summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=switch],[tabindex]:not([tabindex="-1"])'

let activated: HTMLElement | null = null
let activatedAt = 0

function record(e: Event): void {
  const target = e.target
  if (!(target instanceof Element)) return
  if (isTextField(target)) {
    activated = null
    return
  }
  const control = target.closest<HTMLElement>(ACTIVATABLE)
  if (!control) return
  activated = control
  activatedAt = performance.now()
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
  return pickOpener({
    focused,
    activated: activated?.isConnected ? activated : null,
    activatedAgo: performance.now() - activatedAt
  })
}

/** Gives the focus back to `opener` when it is still in the page. True when it did. */
export function restoreFocus(opener: HTMLElement | null): boolean {
  if (!opener?.isConnected) return false
  opener.focus({ preventScroll: true })
  return true
}
