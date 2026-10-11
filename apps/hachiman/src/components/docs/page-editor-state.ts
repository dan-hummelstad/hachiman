import { create } from 'zustand'

/**
 * The state of the touch page editor that the page screen shows outside the editor
 * (docs/ios-mobile-ui-spec.md F2): while the editor has the focus (the keyboard is up), the nav
 * bar shows Done in place of More. One page screen shows at a time, so one store serves it. In
 * memory only.
 */
interface PageEditorState {
  /** The focus is in the editor (its text or a code block in it). */
  focused: boolean
  /**
   * The focus left the editor through a control that goes away with it (Done, the toolbar's hide,
   * a toolbar sheet closed with no pick): the nav bar moves the focus to More, which takes Done's
   * place, so VoiceOver does not land on `<body>`.
   */
  focusMore: boolean
}

export const usePageEditorState = create<PageEditorState>()(() => ({
  focused: false,
  focusMore: false
}))

export const usePageEditorFocused = (): boolean => usePageEditorState((s) => s.focused)

const setFocused = (focused: boolean): void =>
  usePageEditorState.setState((s) => (s.focused === focused ? s : { focused }))

/** The part of an element that `trackEditorFocus` uses (a fake in the tests). */
interface FocusRoot {
  contains: (other: Node | null) => boolean
  addEventListener: (type: 'focusin' | 'focusout', fn: (e: FocusEvent) => void) => void
  removeEventListener: (type: 'focusin' | 'focusout', fn: (e: FocusEvent) => void) => void
}

/**
 * Keeps `focused` in step with the focus inside `root` (the editor root). A move of the focus to
 * another element in the root (a code block) keeps it. Returns the cleanup, which also clears
 * `focused`: an editor that goes away has no focus.
 */
export function trackEditorFocus(root: FocusRoot): () => void {
  const onIn = (): void => {
    setFocused(true)
    clearFocusMore()
  }
  const onOut = (e: FocusEvent): void => {
    const next = e.relatedTarget
    setFocused(next !== null && root.contains(next as Node))
  }
  root.addEventListener('focusin', onIn)
  root.addEventListener('focusout', onOut)
  return () => {
    root.removeEventListener('focusin', onIn)
    root.removeEventListener('focusout', onOut)
    setFocused(false)
  }
}

/**
 * Done in the nav bar and the toolbar's hide: takes the focus out of the editor, so the keyboard
 * goes down. `focusMore`: the nav bar then moves the focus to More.
 */
export function blurPageEditor({ focusMore = false }: { focusMore?: boolean } = {}): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.hm-page-editor')) active.blur()
  setFocused(false)
  if (focusMore) usePageEditorState.setState({ focusMore: true })
}

/**
 * For the `onCloseAutoFocus` of a sheet that the keyboard toolbar opened (Turn into, Link to
 * page): with no pick, nothing took the focus, and the toolbar button that opened the sheet is
 * gone. Then the nav bar moves the focus to More (a button, so no keyboard comes up).
 */
export function focusMoreIfLost(): void {
  const active = document.activeElement
  if (active === null || active === document.body) usePageEditorState.setState({ focusMore: true })
}

/** The nav bar moved the focus to More, or the editor took it back. */
export function clearFocusMore(): void {
  usePageEditorState.setState((s) => (s.focusMore ? { focusMore: false } : s))
}
