import { afterEach, describe, expect, it } from 'vitest'
import { trackEditorFocus, usePageEditorState } from './page-editor-state'

type Listener = (e: FocusEvent) => void

interface FakeRoot {
  root: Parameters<typeof trackEditorFocus>[0]
  fire: (type: 'focusin' | 'focusout', relatedTarget?: object | null) => void
  count: () => number
}

/** A stand-in for the editor root: the nodes it contains, and its focus listeners. */
function fakeRoot(inside: readonly object[]): FakeRoot {
  const listeners = new Map<string, Set<Listener>>()
  const root = {
    contains: (other: Node | null) => other !== null && inside.includes(other),
    addEventListener: (type: string, fn: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn)
  }
  const fire = (type: 'focusin' | 'focusout', relatedTarget: object | null = null): void => {
    for (const fn of listeners.get(type) ?? []) fn({ relatedTarget } as unknown as FocusEvent)
  }
  const count = (): number =>
    (listeners.get('focusin')?.size ?? 0) + (listeners.get('focusout')?.size ?? 0)
  return { root, fire, count }
}

const focused = (): boolean => usePageEditorState.getState().focused

afterEach(() => usePageEditorState.setState({ focused: false, focusMore: false }))

describe('trackEditorFocus', () => {
  it('is focused from a focusin until the focus leaves the root', () => {
    const { root, fire } = fakeRoot([])
    trackEditorFocus(root)
    expect(focused()).toBe(false)
    fire('focusin')
    expect(focused()).toBe(true)
    fire('focusout', {})
    expect(focused()).toBe(false)
  })

  it('stays focused when the focus moves to another element in the root', () => {
    const codeBlock = {}
    const { root, fire } = fakeRoot([codeBlock])
    trackEditorFocus(root)
    fire('focusin')
    fire('focusout', codeBlock)
    expect(focused()).toBe(true)
  })

  it('loses the focus on a blur to nowhere (the keyboard went down)', () => {
    const { root, fire } = fakeRoot([])
    trackEditorFocus(root)
    fire('focusin')
    fire('focusout', null)
    expect(focused()).toBe(false)
  })

  it('removes its listeners and clears the focus on cleanup', () => {
    const { root, fire, count } = fakeRoot([])
    const stop = trackEditorFocus(root)
    fire('focusin')
    expect(count()).toBe(2)
    stop()
    expect(count()).toBe(0)
    expect(focused()).toBe(false)
    fire('focusin')
    expect(focused()).toBe(false)
  })

  it('drops a pending move of the focus to More when the editor takes the focus back', () => {
    const { root, fire } = fakeRoot([])
    trackEditorFocus(root)
    usePageEditorState.setState({ focusMore: true })
    fire('focusin')
    expect(usePageEditorState.getState().focusMore).toBe(false)
  })
})
