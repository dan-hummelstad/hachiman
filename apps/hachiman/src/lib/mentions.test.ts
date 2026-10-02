import { describe, expect, it } from 'vitest'
import { MAX_MENTIONS, mentionsOf, messageMentionsMe } from './mentions'

const me = { id: 'u-me', username: 'kestrel' }

describe('mentionsOf', () => {
  it('gives user mentions for <@id> and resolved @names, and everyone for @everyone', () => {
    const names: Record<string, string> = { marlowe: 'u-marlowe' }
    expect(
      mentionsOf('hi <@u-1> @marlowe @nobody @everyone <@u-1>', (n) => names[n] ?? null)
    ).toEqual([
      { type: 'user', id: 'u-1' },
      { type: 'user', id: 'u-marlowe' },
      { type: 'everyone', id: null }
    ])
  })

  it('caps the list at MAX_MENTIONS', () => {
    const text = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => `<@u-${i}>`).join(' ')
    expect(mentionsOf(text, () => null)).toHaveLength(MAX_MENTIONS)
  })
})

describe('messageMentionsMe', () => {
  it('reads the envelope mentions: me, everyone, or one of my roles', () => {
    expect(messageMentionsMe({ content: '', mentions: [{ type: 'user', id: 'u-me' }] }, me)).toBe(
      true
    )
    expect(messageMentionsMe({ content: '', mentions: [{ type: 'everyone', id: null }] }, me)).toBe(
      true
    )
    expect(
      messageMentionsMe({ content: '', mentions: [{ type: 'role', id: 'r-1' }] }, me, ['r-1'])
    ).toBe(true)
    expect(messageMentionsMe({ content: '', mentions: [{ type: 'user', id: 'u-x' }] }, me)).toBe(
      false
    )
  })

  it('also reads the text', () => {
    expect(messageMentionsMe({ content: 'hey @Kestrel', mentions: [] }, me)).toBe(true)
  })
})
