import { describe, expect, it } from 'vitest'
import { titleDraft, titleKey } from './page-title-field'

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
