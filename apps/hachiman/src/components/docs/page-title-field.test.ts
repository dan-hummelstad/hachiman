import { describe, expect, it } from 'vitest'
import { MAX_PAGE_TITLE_BYTES } from '@/services/docs/page-tree'
import { fitTitle, titleDraft, titleKey } from './page-title-field'

describe('titleDraft', () => {
  it('starts from the title', () => {
    expect(titleDraft({ title: 'Scrim playbook', titleState: 'ok' })).toBe('Scrim playbook')
  })

  it('clears "Untitled" and an empty title, so the user types a new one', () => {
    expect(titleDraft({ title: 'Untitled', titleState: 'ok' })).toBe('')
    expect(titleDraft({ title: '  ', titleState: 'ok' })).toBe('')
  })

  it('starts empty for a title that does not decrypt', () => {
    expect(titleDraft({ title: '', titleState: 'failed' })).toBe('')
    expect(titleDraft({ title: '', titleState: 'pending' })).toBe('')
  })
})

describe('fitTitle', () => {
  const bytes = (s: string): number => new TextEncoder().encode(s).length

  it('keeps a title within the cap as it is, spaces included', () => {
    expect(fitTitle(' Plan ')).toBe(' Plan ')
  })

  it('cuts at MAX_PAGE_TITLE_BYTES of UTF-8', () => {
    expect(bytes(fitTitle('a'.repeat(MAX_PAGE_TITLE_BYTES + 5)))).toBe(MAX_PAGE_TITLE_BYTES)
  })

  it('never cuts a character in two', () => {
    // 3 bytes each: 66 fit in 200 bytes (198), the 67th does not.
    const out = fitTitle('€'.repeat(100))
    expect(out).toBe('€'.repeat(66))
    expect(bytes(out)).toBeLessThanOrEqual(MAX_PAGE_TITLE_BYTES)
  })
})

describe('titleKey', () => {
  const key = (k: string, isComposing = false, keyCode = 0): ReturnType<typeof titleKey> =>
    titleKey({ key: k, isComposing, keyCode })

  it('saves on Enter and cancels on Escape', () => {
    expect(key('Enter')).toBe('save')
    expect(key('Escape')).toBe('cancel')
    expect(key('a')).toBeNull()
  })

  it('ignores the Enter and Escape of an open IME composition', () => {
    // Chromium: isComposing is set.
    expect(key('Enter', true, 229)).toBeNull()
    expect(key('Escape', true, 229)).toBeNull()
    // WebKit: the Enter that picks a candidate has isComposing false and keyCode 229.
    expect(key('Enter', false, 229)).toBeNull()
  })
})
