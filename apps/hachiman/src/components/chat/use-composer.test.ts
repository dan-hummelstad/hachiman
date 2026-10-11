import { describe, expect, it, vi } from 'vitest'

// The hook's store and service graph is not under test here, only the pure helpers.
vi.mock('./mention-items', () => ({ insertFor: vi.fn(), useMentionItems: vi.fn() }))
vi.mock('@/stores/prefsStore', () => ({ usePrefsStore: vi.fn() }))

const { hasContent } = await import('./use-composer')

describe('hasContent', () => {
  it('needs text that is not only white space, or an upload', () => {
    expect(hasContent('', 0)).toBe(false)
    expect(hasContent(' \n ', 0)).toBe(false)
    expect(hasContent('ok', 0)).toBe(true)
    expect(hasContent('', 1)).toBe(true)
  })
})
