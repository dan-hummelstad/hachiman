import { describe, expect, it } from 'vitest'
import type { GuildEmoji } from '@hachiman/client'
import { customEmojiText, customReactionKey, emojisById, parseReactionKey } from './custom-emoji'

const ID = '0b1f4e1c-6d3a-4f39-9a3c-111111111111'
const party: GuildEmoji = {
  id: ID,
  guildId: 'g1',
  name: 'party',
  key: 'u/party.png',
  createdBy: null,
  createdAt: ''
}

describe('custom emoji keys', () => {
  it('writes the message and reaction forms', () => {
    expect(customEmojiText(party)).toBe(`<:party:${ID}>`)
    expect(customReactionKey(party)).toBe(`party:${ID}`)
  })

  it('parses a reaction key, and nothing else', () => {
    expect(parseReactionKey(`party:${ID}`)).toEqual({ name: 'party', id: ID })
    expect(parseReactionKey('👍')).toBeNull()
    expect(parseReactionKey('party:not-an-id')).toBeNull()
    expect(parseReactionKey(`Party:${ID}`)).toBeNull()
  })

  it('fits the reaction emoji limit of the envelope (72 UTF-16 units)', () => {
    expect(customReactionKey({ name: 'a'.repeat(32), id: ID }).length).toBeLessThanOrEqual(72)
  })

  it('indexes the emojis of every guild by id', () => {
    const other = { ...party, id: 'x', guildId: 'g2' }
    const byGuild = new Map([
      ['g1', [party]],
      ['g2', [other]]
    ])
    expect([...emojisById(byGuild).keys()]).toEqual([ID, 'x'])
  })
})
