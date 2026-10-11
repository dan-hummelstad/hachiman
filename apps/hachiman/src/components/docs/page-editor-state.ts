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
}

export const usePageEditorState = create<PageEditorState>()(() => ({ focused: false }))

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
  const onIn = (): void => setFocused(true)
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

/** Done in the nav bar: takes the focus out of the editor, so the keyboard goes down. */
export function blurPageEditor(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.hm-page-editor')) active.blur()
  setFocused(false)
}
