import { describe, expect, it } from 'vitest'
import { chatInviteLink, inviteFromLine, inviteKeysLine } from '@/lib/guild-invite'

const ORIGIN = 'https://takusen.example'
const KEY = 'A'.repeat(42) + 'A'

describe('chatInviteLink', () => {
  it('reads an invite page of this Takusen', () => {
    expect(chatInviteLink(`${ORIGIN}/invite/nt0wl5x`, ORIGIN)).toEqual({
      code: 'nt0wl5x',
      key: null
    })
  })

  it('keeps the key of an invite with history', () => {
    expect(chatInviteLink(`${ORIGIN}/invite/h1st0ry#k=${KEY}`, ORIGIN)).toEqual({
      code: 'h1st0ry',
      key: KEY
    })
  })

  it('compares the origin, not the text', () => {
    expect(chatInviteLink('https://TAKUSEN.example:443/invite/abc12345', ORIGIN)).toEqual({
      code: 'abc12345',
      key: null
    })
  })

  it('leaves links of other servers and other pages alone', () => {
    expect(chatInviteLink('https://evil.example/invite/abc12345', ORIGIN)).toBeNull()
    expect(chatInviteLink('http://takusen.example/invite/abc12345', ORIGIN)).toBeNull()
    expect(chatInviteLink(`${ORIGIN}/dashboard`, ORIGIN)).toBeNull()
    expect(chatInviteLink(`${ORIGIN}/invite/abc12345/extra`, ORIGIN)).toBeNull()
    expect(chatInviteLink('not a url', ORIGIN)).toBeNull()
  })

  it('fails closed on a damaged key', () => {
    expect(chatInviteLink(`${ORIGIN}/invite/h1st0ry#k=short`, ORIGIN)).toBeNull()
    expect(chatInviteLink(`${ORIGIN}/invite/h1st0ry#other`, ORIGIN)).toBeNull()
  })
})

describe('inviteFromLine', () => {
  it('names the DMs for a DM or group DM', () => {
    expect(inviteFromLine('marlowe', { guildId: null, name: null })).toBe(
      'From marlowe, in your DMs'
    )
  })

  it('names the channel in a guild', () => {
    expect(inviteFromLine('marlowe', { guildId: 'g1', name: 'general' })).toBe(
      'From marlowe, in #general'
    )
  })

  it('names only the sender when the channel is not known', () => {
    expect(inviteFromLine('marlowe', undefined)).toBe('From marlowe')
    expect(inviteFromLine('marlowe', { guildId: 'g1', name: null })).toBe('From marlowe')
  })
})

describe('inviteKeysLine', () => {
  it('counts the devices', () => {
    expect(inviteKeysLine('Pixel Pushers', 3)).toBe(
      'Pixel Pushers is end-to-end encrypted. Your 3 devices get its keys when you join.'
    )
    expect(inviteKeysLine('Pixel Pushers', 1)).toBe(
      'Pixel Pushers is end-to-end encrypted. Your device gets its keys when you join.'
    )
  })

  it('leaves out an unknown count', () => {
    expect(inviteKeysLine('Pixel Pushers', null)).toBe(
      'Pixel Pushers is end-to-end encrypted. Your devices get its keys when you join.'
    )
    expect(inviteKeysLine('Pixel Pushers', 0)).toBe(
      'Pixel Pushers is end-to-end encrypted. Your devices get its keys when you join.'
    )
  })
})
