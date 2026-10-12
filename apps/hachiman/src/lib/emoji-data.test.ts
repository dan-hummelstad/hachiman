import { describe, expect, it } from 'vitest'
import {
  buildEmojiData,
  newestFromProbes,
  replaceShortcodes,
  searchEmoji,
  withSkin
} from './emoji-data'

const data = buildEmojiData(
  [
    { hexcode: '1F600', label: 'grinning face', unicode: '😀', group: 0, tags: ['face', 'grin'] },
    { hexcode: '1F602', label: 'face with tears of joy', unicode: '😂', group: 0, tags: ['laugh'] },
    {
      hexcode: '1F44B',
      label: 'waving hand',
      unicode: '👋',
      group: 1,
      tags: ['hello'],
      skins: ['👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'].map((unicode) => ({ unicode }))
    },
    { hexcode: '1F3FB', label: 'light skin tone', unicode: '🏻', group: 2 },
    { hexcode: '1F1E6', label: 'regional indicator A', unicode: '🇦' }
  ],
  { '1F600': 'grinning', '1F602': 'joy', '1F44B': ['wave', 'waving_hand'] }
)

describe('buildEmojiData', () => {
  it('drops the components and ungrouped entries and maps the groups', () => {
    expect(data.emojis.map((e) => e.emoji)).toEqual(['😀', '😂', '👋'])
    expect(data.emojis.map((e) => e.group)).toEqual([0, 0, 1])
    expect(data.byShortcode.get('waving_hand')?.emoji).toBe('👋')
    expect(data.byEmoji.get('👋🏽')?.emoji).toBe('👋')
  })

  it('leaves out the hexcodes that the device cannot draw', () => {
    const some = buildEmojiData(
      [
        { hexcode: '1F600', label: 'grinning face', unicode: '😀', group: 0 },
        { hexcode: '1FAEA', label: 'distorted face', unicode: '\u{1FAEA}', group: 0 }
      ],
      { '1F600': 'grinning', '1FAEA': 'distorted_face' },
      new Set(['1FAEA'])
    )
    expect(some.emojis.map((e) => e.label)).toEqual(['grinning face'])
    expect(some.byShortcode.has('distorted_face')).toBe(false)
  })

  it('applies a skin tone only where the emoji has tones', () => {
    const wave = data.byShortcode.get('wave')!
    expect(withSkin(wave, 0)).toBe('👋')
    expect(withSkin(wave, 3)).toBe('👋🏽')
    expect(withSkin(data.byShortcode.get('joy')!, 3)).toBe('😂')
  })
})

describe('searchEmoji', () => {
  it('ranks shortcode prefixes before label words and tags', () => {
    expect(searchEmoji(data, 'jo').map((e) => e.emoji)).toEqual(['😂'])
    expect(searchEmoji(data, ':wave').map((e) => e.emoji)).toEqual(['👋'])
    expect(searchEmoji(data, 'hello').map((e) => e.emoji)).toEqual(['👋'])
    expect(searchEmoji(data, 'face').map((e) => e.emoji)).toEqual(['😀', '😂'])
    expect(searchEmoji(data, 'tears of').map((e) => e.emoji)).toEqual(['😂'])
    expect(searchEmoji(data, '  ')).toEqual([])
  })
})

describe('replaceShortcodes', () => {
  it('turns known shortcodes into emojis and leaves the rest', () => {
    expect(replaceShortcodes('gg :joy: :nope: :wave:', data)).toBe('gg 😂 :nope: 👋')
  })

  it('leaves custom emoji wire forms alone, even with a Unicode name', () => {
    const id = '0b1f4e1c-6d3a-4f39-9a3c-111111111111'
    expect(replaceShortcodes(`<:joy:${id}> :joy:`, data)).toBe(`<:joy:${id}> 😂`)
  })
})

describe('newestFromProbes', () => {
  const upTo = (codepoint: number) => (emoji: string) => (emoji.codePointAt(0) ?? 0) <= codepoint

  it('gives the newest version whose probe draws', () => {
    expect(newestFromProbes(upTo(0x1fae8))).toBe(15)
    expect(newestFromProbes(() => true)).toBe(17)
  })

  it('gives 12.1 when the baseline draws but no newer probe does', () => {
    expect(newestFromProbes((emoji) => emoji === '\u{1F600}')).toBe(12.1)
  })

  it('gives null for a blank or placeholder readback, so every emoji stays', () => {
    expect(newestFromProbes(() => false)).toBeNull()
  })
})
