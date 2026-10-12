import { describe, expect, it } from 'vitest'
import { DEFAULT_CUSTOM_GRADIENT } from '@/lib/guild-tint'
import {
  DEFAULT_MESSAGE_TEXT_SIZE,
  MESSAGE_TEXT_SIZES,
  isMessageTextSize,
  mergePersistedPrefs,
  usePrefsStore
} from '@/stores/prefsStore'

const current = {
  theme: 'dark' as const,
  customGradient: DEFAULT_CUSTOM_GRADIENT,
  messageTextSize: DEFAULT_MESSAGE_TEXT_SIZE
}

describe('message text size', () => {
  it('has five steps with 15 as the default', () => {
    expect(MESSAGE_TEXT_SIZES).toEqual([13, 14, 15, 17, 19])
    expect(DEFAULT_MESSAGE_TEXT_SIZE).toBe(15)
    expect(usePrefsStore.getState().messageTextSize).toBe(15)
  })

  it('accepts only the steps', () => {
    for (const size of MESSAGE_TEXT_SIZES) expect(isMessageTextSize(size)).toBe(true)
    for (const bad of [16, 0, '15', null, undefined, 15.5])
      expect(isMessageTextSize(bad)).toBe(false)
  })

  it('sets a step', () => {
    usePrefsStore.getState().setMessageTextSize(17)
    expect(usePrefsStore.getState().messageTextSize).toBe(17)
    usePrefsStore.getState().setMessageTextSize(DEFAULT_MESSAGE_TEXT_SIZE)
  })
})

describe('mergePersistedPrefs', () => {
  it('keeps the defaults when nothing is stored', () => {
    expect(mergePersistedPrefs(undefined, current)).toEqual(current)
  })

  it('takes a stored step and the other stored values', () => {
    expect(mergePersistedPrefs({ theme: 'light', messageTextSize: 19 }, current)).toEqual({
      ...current,
      theme: 'light',
      messageTextSize: 19
    })
  })

  it('falls back to the default for data stored before the text size, or a size off the steps', () => {
    expect(mergePersistedPrefs({ theme: 'light' }, current).messageTextSize).toBe(15)
    expect(mergePersistedPrefs({ messageTextSize: 16 }, current).messageTextSize).toBe(15)
    expect(mergePersistedPrefs({ messageTextSize: '17' }, current).messageTextSize).toBe(15)
  })

  it('falls back to the default gradient for one of an older shape', () => {
    const merged = mergePersistedPrefs({ customGradient: { from: 1 } }, current)
    expect(merged.customGradient).toBe(DEFAULT_CUSTOM_GRADIENT)
  })
})
